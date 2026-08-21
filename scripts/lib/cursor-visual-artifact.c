#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_DIRECTORY
#error "descriptor-relative visual artifacts require O_DIRECTORY"
#endif
#ifndef O_NOFOLLOW
#error "descriptor-relative visual artifacts require O_NOFOLLOW"
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#error "descriptor-relative visual artifacts require AT_SYMLINK_NOFOLLOW"
#endif

#define MAX_PATH_BYTES 32768u
#define IO_BUFFER_BYTES (64u * 1024u)

static int same_identity(const struct stat *left, const struct stat *right) {
	return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int is_canonical_absolute(const char *path) {
	const size_t length = strlen(path);
	if (length == 0 || length > MAX_PATH_BYTES || path[0] != '/') return 0;
	if (length == 1) return 1;
	size_t start = 1;
	for (size_t index = 1; index <= length; index++) {
		if (index < length && path[index] != '/') continue;
		const size_t component_length = index - start;
		if (component_length == 0 ||
			(component_length == 1 && path[start] == '.') ||
			(component_length == 2 && path[start] == '.' && path[start + 1] == '.')) return 0;
		start = index + 1;
	}
	return 1;
}

static int open_directory_path(const char *path, int create) {
	char *copy = strdup(path);
	if (!copy) return -1;
	int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	if (current < 0) {
		free(copy);
		return -1;
	}
	char *cursor = copy + 1;
	while (*cursor) {
		char *slash = strchr(cursor, '/');
		if (slash) *slash = '\0';
		int next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		if (next < 0 && errno == ENOENT && create) {
			if (mkdirat(current, cursor, 0700) != 0 && errno != EEXIST) {
				close(current);
				free(copy);
				return -1;
			}
			next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		}
		if (next < 0) {
			close(current);
			free(copy);
			return -1;
		}
		struct stat stat;
		if (fstat(next, &stat) != 0 || !S_ISDIR(stat.st_mode)) {
			close(next);
			close(current);
			free(copy);
			return -1;
		}
		close(current);
		current = next;
		if (!slash) break;
		cursor = slash + 1;
	}
	free(copy);
	return current;
}

static int split_parent(const char *path, char **parent_out, char **name_out) {
	char *copy = strdup(path);
	if (!copy) return 0;
	char *slash = strrchr(copy, '/');
	if (!slash || slash[1] == '\0') {
		free(copy);
		return 0;
	}
	char *name = strdup(slash + 1);
	if (!name) {
		free(copy);
		return 0;
	}
	if (slash == copy) {
		slash[1] = '\0';
	} else {
		*slash = '\0';
	}
	*parent_out = copy;
	*name_out = name;
	return 1;
}

static int ensure_directory(const char *path) {
	const int descriptor = open_directory_path(path, 1);
	if (descriptor < 0) return 0;
	return close(descriptor) == 0;
}

static int read_and_write(int descriptor) {
	unsigned char buffer[IO_BUFFER_BYTES];
	for (;;) {
		const ssize_t read_count = read(STDIN_FILENO, buffer, sizeof(buffer));
		if (read_count == 0) return 1;
		if (read_count < 0) {
			if (errno == EINTR) continue;
			return 0;
		}
		size_t offset = 0;
		while (offset < (size_t)read_count) {
			const ssize_t write_count = write(descriptor, buffer + offset, (size_t)read_count - offset);
			if (write_count < 0 && errno == EINTR) continue;
			if (write_count <= 0) return 0;
			offset += (size_t)write_count;
		}
	}
}

static int target_is_acceptable(int parent, const char *name, struct stat *before, int *exists) {
	if (fstatat(parent, name, before, AT_SYMLINK_NOFOLLOW) == 0) {
		*exists = 1;
		return S_ISREG(before->st_mode);
	}
	if (errno == ENOENT) {
		*exists = 0;
		return 1;
	}
	return 0;
}

static int write_file(const char *path) {
	char *parent_path = NULL;
	char *name = NULL;
	if (!split_parent(path, &parent_path, &name)) return 0;
	const int parent = open_directory_path(parent_path, 1);
	free(parent_path);
	if (parent < 0) {
		free(name);
		return 0;
	}
	struct stat target_before;
	int target_exists = 0;
	if (!target_is_acceptable(parent, name, &target_before, &target_exists)) {
		close(parent);
		free(name);
		return 0;
	}

	char temporary[NAME_MAX + 1];
	int temporary_fd = -1;
	for (unsigned int attempt = 0; attempt < 100; attempt++) {
		snprintf(temporary, sizeof(temporary), ".pi-cursor-artifact.%ld.%u", (long)getpid(), attempt);
		temporary_fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
		if (temporary_fd >= 0) break;
		if (errno != EEXIST) break;
	}
	if (temporary_fd < 0) {
		close(parent);
		free(name);
		return 0;
	}
	struct stat temporary_stat;
	const int temporary_stat_valid = fstat(temporary_fd, &temporary_stat) == 0;
	int ok = temporary_stat_valid && S_ISREG(temporary_stat.st_mode) && read_and_write(temporary_fd);
	if (ok) {
		struct stat current_target;
		if (fstatat(parent, name, &current_target, AT_SYMLINK_NOFOLLOW) == 0) {
			ok = target_exists && S_ISREG(current_target.st_mode) && same_identity(&target_before, &current_target);
		} else {
			ok = !target_exists && errno == ENOENT;
		}
	}
	if (close(temporary_fd) != 0) ok = 0;
	if (ok && renameat(parent, temporary, parent, name) != 0) ok = 0;
	if (ok) {
		struct stat after;
		ok = fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) == 0 &&
			S_ISREG(after.st_mode) && same_identity(&temporary_stat, &after);
	}
	if (!ok && temporary_stat_valid) {
		struct stat current;
		if (fstatat(parent, temporary, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
			same_identity(&temporary_stat, &current)) unlinkat(parent, temporary, 0);
	}
	close(parent);
	free(name);
	return ok;
}

static int remove_file(const char *path) {
	char *parent_path = NULL;
	char *name = NULL;
	if (!split_parent(path, &parent_path, &name)) return 0;
	const int parent = open_directory_path(parent_path, 0);
	free(parent_path);
	if (parent < 0) {
		free(name);
		return errno == ENOENT;
	}
	struct stat before;
	if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
		const int absent = errno == ENOENT;
		close(parent);
		free(name);
		return absent;
	}
	if (!S_ISREG(before.st_mode)) {
		close(parent);
		free(name);
		return 0;
	}
	struct stat current;
	const int unchanged = fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_identity(&before, &current) && S_ISREG(current.st_mode);
	const int removed = unchanged && unlinkat(parent, name, 0) == 0;
	close(parent);
	free(name);
	return removed;
}

int main(int argc, char **argv) {
	if (argc != 3 || !is_canonical_absolute(argv[2])) return 2;
	int ok = 0;
	if (strcmp(argv[1], "ensure") == 0) ok = ensure_directory(argv[2]);
	else if (strcmp(argv[1], "write") == 0) ok = write_file(argv[2]);
	else if (strcmp(argv[1], "remove") == 0) ok = remove_file(argv[2]);
	else return 2;
	if (!ok) fprintf(stderr, "secure visual artifact %s failed: %s\n", argv[1], strerror(errno));
	return ok ? 0 : 1;
}
