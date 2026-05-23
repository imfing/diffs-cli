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
			timer = time.NewTimer(150 * time.Millisecond)
			timerC = timer.C
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(150 * time.Millisecond)
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
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		if w.skipDir(name) {
			return filepath.SkipDir
		}
		_ = w.addDir(name)
		return nil
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

func sortedKeys(values map[string]struct{}) []string {
	paths := make([]string, 0, len(values))
	for path := range values {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
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
