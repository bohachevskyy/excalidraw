/**
 * Persists a list of recently opened/saved local diagrams so the user can
 * quickly switch between them from the main menu without re-browsing the OS
 * file picker.
 *
 * We store the `FileSystemFileHandle` (which is structured-cloneable, so it
 * survives in IndexedDB) alongside lightweight metadata. Browsers do NOT expose
 * the absolute filesystem path to web apps, so we can only persist/display the
 * file's name — reopening a handle in a later session requires a one-time
 * permission grant (triggered from a user gesture in the dialog).
 */
import { createStore, get, set, del } from "idb-keyval";

export interface RecentFileEntry {
  /** stable id, used as React key and for removal */
  id: string;
  /** file name as reported by the handle (e.g. `diagram.excalidraw`) */
  name: string;
  /** re-openable handle to the file on disk */
  handle: FileSystemFileHandle;
  /** epoch ms of the last time the file was opened/saved */
  lastOpened: number;
}

const MAX_RECENT_FILES = 15;
const RECENT_FILES_KEY = "recentFiles";

const recentFilesStore = createStore("recent-files-db", "recent-files-store");

const readEntries = async (): Promise<RecentFileEntry[]> => {
  try {
    return (
      (await get<RecentFileEntry[]>(RECENT_FILES_KEY, recentFilesStore)) ?? []
    );
  } catch (error) {
    console.error("Failed to read recent files", error);
    return [];
  }
};

const writeEntries = (entries: RecentFileEntry[]) =>
  set(RECENT_FILES_KEY, entries, recentFilesStore);

/** Returns recent files, most-recently-opened first. */
export const getRecentFiles = async (): Promise<RecentFileEntry[]> => {
  const entries = await readEntries();
  return [...entries].sort((a, b) => b.lastOpened - a.lastOpened);
};

/**
 * Upserts a handle into the recent list (deduping by the underlying file via
 * `isSameEntry`) and bumps its `lastOpened` timestamp. Caps the list length.
 */
export const addRecentFile = async (
  handle: FileSystemFileHandle,
): Promise<void> => {
  const entries = await readEntries();

  let matchedIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    try {
      if (await entries[i].handle.isSameEntry(handle)) {
        matchedIndex = i;
        break;
      }
    } catch {
      // ignore comparison failures (e.g. revoked handle) and keep scanning
    }
  }

  const now = Date.now();
  const existing = matchedIndex >= 0 ? entries[matchedIndex] : null;
  const entry: RecentFileEntry = {
    id: existing?.id ?? `${now}-${handle.name}`,
    name: handle.name,
    handle,
    lastOpened: now,
  };

  if (matchedIndex >= 0) {
    entries.splice(matchedIndex, 1);
  }
  entries.unshift(entry);

  try {
    await writeEntries(entries.slice(0, MAX_RECENT_FILES));
  } catch (error) {
    // structured-cloning the handle into IndexedDB can fail in some browsers;
    // surface it rather than failing silently
    console.error("Failed to save recent file", error);
  }
};

export const removeRecentFile = async (id: string): Promise<void> => {
  const entries = await readEntries();
  await writeEntries(entries.filter((entry) => entry.id !== id));
};

export const clearRecentFiles = async (): Promise<void> => {
  try {
    await del(RECENT_FILES_KEY, recentFilesStore);
  } catch (error) {
    console.error("Failed to clear recent files", error);
  }
};
