import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import type { CursorRuntime } from "./cursor-config.js";
import { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome, recordCursorProviderAbandonUsage } from "./cursor-provider-turn-finalize.js";
import {
	discardIncompleteToolsFromPrepared,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { CursorRunFinalizer, type CursorLiveRunCompletion } from "./cursor-provider-run-finalizer.js";
import {
	prepareCursorProviderTurn,
	requireCursorApiKey,
	resolveCursorProviderTurnConfig,
} from "./cursor-provider-turn-prepare.js";
import {
	shouldRetryStaleLocalAuthFailure,
	shouldRetryStaleLocalCursorAuthWaitOutcome,
} from "./cursor-provider-stale-auth-retry.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSendResult,
	LiveCursorProviderTurnRuntime,
	LocalCursorProviderTurnPrepareResult,
	StartedCursorProviderTurn,
} from "./cursor-provider-turn-types.js";

export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

type LocalLivePreparedTurn = StartedCursorProviderTurn & LocalCursorProviderTurnPrepareResult & { runtime: LiveCursorProviderTurnRuntime };

type CursorProviderAttemptProgress =
	| { kind: "empty" }
	| { kind: "prepared"; prepared: CursorProviderTurnPrepareResult }
	| { kind: "started"; prepared: StartedCursorProviderTurn }
	| { kind: "sent"; prepared: StartedCursorProviderTurn; sendResult: CursorProviderTurnSendResult }
	| {
			kind: "live";
			prepared: StartedCursorProviderTurn;
			sendResult: CursorProviderTurnSendResult;
			liveCompletion: CursorLiveRunCompletion;
	  };

function getAttemptPreparedTurn(progress: CursorProviderAttemptProgress): CursorProviderTurnPrepareResult | undefined {
	return progress.kind === "empty" ? undefined : progress.prepared;
}

function getAttemptStartedTurn(progress: CursorProviderAttemptProgress): StartedCursorProviderTurn | undefined {
	return progress.kind === "started" || progress.kind === "sent" || progress.kind === "live"
		? progress.prepared
		: undefined;
}

function getAttemptSendResult(progress: CursorProviderAttemptProgress): CursorProviderTurnSendResult | undefined {
	return progress.kind === "sent" || progress.kind === "live" ? progress.sendResult : undefined;
}

function getAttemptLiveCompletion(progress: CursorProviderAttemptProgress): CursorLiveRunCompletion | undefined {
	return progress.kind === "live" ? progress.liveCompletion : undefined;
}

function requireLocalLivePreparedTurn(prepared: StartedCursorProviderTurn): LocalLivePreparedTurn {
	if (prepared.runtimeTarget !== "local" || prepared.execution !== "conversation" || prepared.runtime.kind !== "live") {
		throw new Error("Cursor live run requires a local live prepared turn");
	}
	return prepared as LocalLivePreparedTurn;
}

export class CursorProviderTurnRunner {
	private sdkEventDebug: CursorSdkEventDebugSink | undefined;
	private resolvedApiKey: string | undefined;
	private runtimeTarget: CursorRuntime | undefined;

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private throwIfAborted(): void {
		if (this.options?.signal?.aborted) throw new CursorLiveRunAbortError();
	}

	async run(sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>): Promise<void> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;
		let attemptCleanupComplete = false;
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard,
			resolvedApiKey: () => this.resolvedApiKey,
			runtimeTarget: () => this.runtimeTarget,
		});

		try {
			this.throwIfAborted();
			const { scope } = this.params;
			const cwd = scope.cwd;
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
				scope,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			const resolvedConfig = resolveCursorProviderTurnConfig(cwd, scope.projectTrusted, scope.scopeKey);
			this.runtimeTarget = resolvedConfig.runtime.value;
			if (resolvedConfig.runtime.value === "local" && this.params.request.purpose === "normal") {
				if (
					(await drainExistingCursorLiveRunBeforeSend(
						stream,
						partial,
						model,
						context,
						options?.signal,
						this.sdkEventDebug,
						scope.scopeKey,
						this.params.request.occupancyFloor,
					)) === "stream_ended"
				) {
					return;
				}
			}
			this.throwIfAborted();

			const resolvedApiKey = requireCursorApiKey(options);
			this.resolvedApiKey = resolvedApiKey;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				let progress: CursorProviderAttemptProgress = { kind: "empty" };
				let retrying = false;
				try {
					const prepared = await prepareCursorProviderTurn({
						params: this.params,
						cwd,
						resolvedApiKey,
						sdkEventDebug: this.sdkEventDebug,
						throwIfAborted: () => this.throwIfAborted(),
						resolvedConfig,
						forceCreate: attempt === 0 ? undefined : true,
					});
					progress = { kind: "prepared", prepared };
					const usage = await this.params.usageRecorder.start({
						agent: prepared.agent,
						runtime: prepared.runtimeTarget,
						model: { id: model.id, provider: model.provider, cost: { ...model.cost } },
						modelSelection: prepared.meta.modelSelection,
						purpose: this.params.request.purpose,
						...(prepared.runtimeTarget === "local" ? { storeIdentity: prepared.storeIdentity.stateRoot } : {}),
						resumed: prepared.runtimeTarget === "local" && prepared.execution === "conversation" && prepared.sessionAgentLease.resumed === true,
						newlyCreated: prepared.runtimeTarget !== "local" || prepared.execution === "summary" || (prepared.sessionAgentLease.created && !prepared.sessionAgentLease.resumed),
					}).catch((error: unknown) => {
						this.params.usageRecorder.notePersistenceFailure(error);
						throw error;
					});
					const started: StartedCursorProviderTurn = { ...prepared, usage };
					progress = { kind: "started", prepared: started };
					if (started.runtime.liveRun) {
						started.runtime.liveRun.onAbandon = async () => {
							await recordCursorProviderAbandonUsage(started);
						};
					}

					const sendResult = await sendCursorProviderTurn({
						params: this.params,
						prepared: started,
						sdkEventDebug: this.sdkEventDebug,
						sdkProcessErrorGuard,
						throwIfAborted: () => this.throwIfAborted(),
						resolvedApiKey,
					});
					progress = { kind: "sent", prepared: started, sendResult };

					if (started.runtime.kind === "live") {
						const livePrepared = requireLocalLivePreparedTurn(started);
						const liveCompletion = runFinalizer.startLiveRunCompletion({
							send: sendResult.send,
							prepared: livePrepared,
							modelId: model.id,
							discardIncompleteTools: (outcome) => discardIncompleteToolsFromPrepared(livePrepared, outcome),
						});
						progress = { kind: "live", prepared: started, sendResult, liveCompletion };
						await emitCursorLiveTurn({
							params: this.params,
							prepared: livePrepared,
							sdkEventDebug: this.sdkEventDebug,
							discardIncompleteTools: (outcome) => discardIncompleteToolsFromPrepared(livePrepared, outcome),
						});
						return;
					}

					const outcomePromise = awaitFinalizeCursorRunOutcome({
						run: sendResult.send.run,
						prepared: started,
						cursorAgentMessageOffset: sendResult.send.cursorAgentMessageOffset,
						modelId: model.id,
						signal: options?.signal,
						runResultFallback: sendResult.send.run.result,
						runErrorFallback: sendResult.send.run.error,
						resolvedApiKey,
						optionsApiKey: options?.apiKey,
						sdkEventDebug: this.sdkEventDebug,
						contextWindowAgentId: prepared.contextWindowAgentId,
					});
					started.lifecycle.trackRunCompletion(outcomePromise);
					const finalized = await outcomePromise;
					if (attempt === 0 && shouldRetryStaleLocalCursorAuthWaitOutcome(
						started,
						finalized.outcome,
						this.params.partial.content.length > 0,
					)) {
						this.recordStaleAuthRetry(started);
						await runFinalizer.discardStaleAuthAttempt({ prepared: started, sendResult, liveCompletion: undefined });
						retrying = true;
						continue;
					}
					await runFinalizer.applyTerminalEvent({
						kind: "direct",
						prepared: started,
						outcome: finalized.outcome,
						displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
					});
					return;
				} catch (error) {
					const started = getAttemptStartedTurn(progress);
					if (attempt === 0 && started && shouldRetryStaleLocalAuthFailure(
						started,
						error,
						this.params.partial.content.length > 0,
					) && !options?.signal?.aborted) {
						this.recordStaleAuthRetry(started);
						await runFinalizer.discardStaleAuthAttempt({
							prepared: started,
							sendResult: getAttemptSendResult(progress),
							liveCompletion: getAttemptLiveCompletion(progress),
						});
						retrying = true;
						continue;
					}
					await runFinalizer.applyTerminalEvent({
						kind: "error",
						prepared: getAttemptStartedTurn(progress) ?? getAttemptPreparedTurn(progress),
						error,
					});
					return;
				} finally {
					if (!retrying) {
						await runFinalizer.cleanup(
							getAttemptPreparedTurn(progress),
							getAttemptSendResult(progress),
							getAttemptLiveCompletion(progress),
						);
						attemptCleanupComplete = true;
					}
				}
			}
		} catch (error) {
			await runFinalizer.applyTerminalEvent({ kind: "error", prepared: undefined, error });
		} finally {
			if (!attemptCleanupComplete) await runFinalizer.cleanup(undefined, undefined, undefined);
		}
	}

	private recordStaleAuthRetry(prepared: StartedCursorProviderTurn): void {
		try {
			this.sdkEventDebug?.recordProviderEvent("stale_local_agent_unauthenticated_retry", {
				sendPlanReason: prepared.meta.sendPlan.reason,
			});
		} catch {
			// Debug capture is optional and must never change provider execution.
		}
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard: installCursorSdkProcessErrorGuard(),
			resolvedApiKey: () => this.resolvedApiKey,
			runtimeTarget: () => this.runtimeTarget,
		});
		await runFinalizer.applyTerminalEvent({ kind: "error", prepared: undefined, error });
		await runFinalizer.cleanup(undefined, undefined, undefined);
	}
}
