package server

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	gitcmd "github.com/imfing/diffs-cli/internal/git"
)

const (
	watchDebounce    = 150 * time.Millisecond
	gitStatusTimeout = 2 * time.Second
)

type changeBroadcaster struct {
	mu      sync.Mutex
	clients map[chan struct{}]struct{}
}

func newChangeBroadcaster() *changeBroadcaster {
	return &changeBroadcaster{clients: make(map[chan struct{}]struct{})}
}

func (b *changeBroadcaster) subscribe(ctx context.Context) <-chan struct{} {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.mu.Lock()
		delete(b.clients, ch)
		b.mu.Unlock()
	}()

	return ch
}

func (b *changeBroadcaster) broadcast() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

type localWatcher struct {
	cwd     string
	watcher *fsnotify.Watcher

	mu      sync.Mutex
	watched map[string]struct{}
}

type ChangeAction string

const (
	ChangeAdded    ChangeAction = "added"
	ChangeModified ChangeAction = "modified"
	ChangeDeleted  ChangeAction = "deleted"
	ChangeRenamed  ChangeAction = "renamed"
)

type ChangedFile struct {
	Path   string
	Action ChangeAction
}

func newLocalWatcher(cwd string, notify func([]string)) (*localWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &localWatcher{
		cwd:     cwd,
		watcher: watcher,
		watched: make(map[string]struct{}),
	}
	if err := w.addDirRecursive(cwd); err != nil {
		_ = watcher.Close()
		return nil, err
	}

	go w.run(notify)
	return w, nil
}

func (w *localWatcher) run(notify func([]string)) {
	var timer *time.Timer
	var timerC <-chan time.Time
	pending := make(map[string]struct{})
	schedule := func(name string) {
		pending[w.displayName(name)] = struct{}{}
		if timer == nil {
			timer = time.NewTimer(watchDebounce)
			timerC = timer.C
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(watchDebounce)
	}

	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				if timer != nil {
					timer.Stop()
				}
				return
			}
			if w.ignore(event.Name) {
				continue
			}
			if event.Has(fsnotify.Create) {
				w.addCreatedDir(event.Name)
			}
			if w.shouldSchedule(event) {
				schedule(event.Name)
			}
		case _, ok := <-w.watcher.Errors:
			if !ok {
				if timer != nil {
					timer.Stop()
				}
				return
			}
		case <-timerC:
			paths := sortedKeys(pending)
			pending = make(map[string]struct{})
			timerC = nil
			timer = nil
			notify(paths)
		}
	}
}

func (w *localWatcher) shouldSchedule(event fsnotify.Event) bool {
	return event.Has(fsnotify.Create) || event.Has(fsnotify.Write) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)
}

func (w *localWatcher) addCreatedDir(name string) {
	info, err := os.Stat(name)
	if err != nil || !info.IsDir() {
		return
	}
	_ = w.addDirRecursive(name)
}

func (w *localWatcher) addDirRecursive(root string) error {
	return filepath.WalkDir(root, func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if w.skipDir(name) {
			return filepath.SkipDir
		}
		return w.addDir(name)
	})
}

func (w *localWatcher) addDir(name string) error {
	abs, err := filepath.Abs(name)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.watched[abs]; ok {
		return nil
	}
	if err := w.watcher.Add(abs); err != nil {
		return err
	}
	w.watched[abs] = struct{}{}
	return nil
}

func (w *localWatcher) ignore(name string) bool {
	if w.isCommentTempFile(name) {
		return true
	}
	return skippedPathPart(w.cwd, name)
}

func (w *localWatcher) skipDir(name string) bool {
	if name == w.cwd {
		return false
	}
	return skippedPathPart(w.cwd, name)
}

func (w *localWatcher) displayName(name string) string {
	rel, err := filepath.Rel(w.cwd, name)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return filepath.ToSlash(name)
	}
	return filepath.ToSlash(rel)
}

func (w *localWatcher) isCommentTempFile(name string) bool {
	rel, err := filepath.Rel(w.cwd, name)
	if err != nil {
		return false
	}
	return strings.HasPrefix(rel, ".diffs"+string(filepath.Separator)+".comments-") && strings.HasSuffix(rel, ".json")
}

func sortedKeys(values map[string]struct{}) []string {
	paths := make([]string, 0, len(values))
	for path := range values {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func gitStatus(cwd string) (map[string]ChangeAction, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitStatusTimeout)
	defer cancel()

	out, err := gitcmd.Run(ctx, cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	statusByPath := make(map[string]ChangeAction)
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		status := entry[:2]
		path := entry[3:]
		if status[0] == 'R' || status[0] == 'C' {
			// With porcelain -z, rename/copy records are "XY new\0old\0".
			// Keep the new path as the status key and only consume the old path.
			i++
			if i >= len(entries) {
				continue
			}
		}
		if path == "" || skippedPathPart(cwd, filepath.FromSlash(path)) {
			continue
		}
		statusByPath[filepath.ToSlash(path)] = gitStatusAction(status)
	}
	return statusByPath, nil
}

func changedFilesForEvents(events []string, statusByPath map[string]ChangeAction) []ChangedFile {
	if len(events) == 0 || len(statusByPath) == 0 {
		return nil
	}
	matches := make(map[string]ChangedFile)
	for _, eventPath := range events {
		eventPath = cleanEventPath(eventPath)
		if eventPath == "" {
			continue
		}
		if action, ok := statusByPath[eventPath]; ok {
			matches[eventPath] = ChangedFile{Path: eventPath, Action: action}
			continue
		}
		prefix := eventPath + "/"
		for path, action := range statusByPath {
			if strings.HasPrefix(path, prefix) {
				matches[path] = ChangedFile{Path: path, Action: action}
			}
		}
	}
	return sortedChangedFiles(matches)
}

func changedFilesFromEvents(events []string) []ChangedFile {
	files := make(map[string]ChangedFile)
	for _, path := range events {
		path = cleanEventPath(path)
		if path == "" {
			continue
		}
		files[path] = ChangedFile{Path: path, Action: ChangeModified}
	}
	return sortedChangedFiles(files)
}

func cleanEventPath(path string) string {
	return strings.Trim(filepath.ToSlash(path), "/")
}

func gitStatusAction(status string) ChangeAction {
	if strings.Contains(status, "D") {
		return ChangeDeleted
	}
	if strings.ContainsAny(status, "RC") {
		return ChangeRenamed
	}
	if strings.Contains(status, "A") || status == "??" {
		return ChangeAdded
	}
	return ChangeModified
}

func sortedChangedFiles(values map[string]ChangedFile) []ChangedFile {
	paths := make([]string, 0, len(values))
	for path := range values {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	files := make([]ChangedFile, 0, len(paths))
	for _, path := range paths {
		files = append(files, values[path])
	}
	return files
}

func skippedPathPart(root, name string) bool {
	rel, err := filepath.Rel(root, name)
	if err != nil || rel == "." {
		return false
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		switch part {
		case ".git", ".hg", ".svn", "node_modules":
			return true
		}
	}
	return false
}
