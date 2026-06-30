import { useCallback, useEffect, useState } from "react";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { LoadIcon, TrashIcon } from "@excalidraw/excalidraw/components/icons";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { saveAsJSON } from "@excalidraw/excalidraw/data/json";
import { hashElementsVersion } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { atom, useAtom } from "../app-jotai";
import {
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
  type RecentFileEntry,
} from "../data/recentFiles";

/** Controls visibility of the recent files dialog. */
export const recentFilesDialogStateAtom = atom(false);

/**
 * Hash of the scene as it was last loaded from / saved to its file handle.
 * Used to detect unsaved changes ("dirty") before switching files. `null` means
 * we have no baseline yet (treated as "clean").
 */
export const savedSceneHashAtom = atom<number | null>(null);

/**
 * Non-standard File System Access permission API (not yet in lib.dom types).
 * Persisted handles reset to the "prompt" permission state on a new session, so
 * we must request access from within a user gesture before reading.
 */
type FileSystemPermissionMode = "read" | "readwrite";
interface FileSystemHandleWithPermissions {
  queryPermission?: (descriptor: {
    mode: FileSystemPermissionMode;
  }) => Promise<PermissionState>;
  requestPermission?: (descriptor: {
    mode: FileSystemPermissionMode;
  }) => Promise<PermissionState>;
}

const ensureReadPermission = async (
  handle: FileSystemFileHandle,
): Promise<boolean> => {
  const withPermissions = handle as unknown as FileSystemHandleWithPermissions;
  // Older/unsupported browsers don't expose the permission API; assume granted.
  if (!withPermissions.queryPermission || !withPermissions.requestPermission) {
    return true;
  }
  if ((await withPermissions.queryPermission({ mode: "read" })) === "granted") {
    return true;
  }
  return (
    (await withPermissions.requestPermission({ mode: "read" })) === "granted"
  );
};

const formatRelativeTime = (timestamp: number): string => {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) {
    return t("recentFiles.justNow");
  }
  if (minutes < 60) {
    return t("recentFiles.minutesAgo", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t("recentFiles.hoursAgo", { count: hours });
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return t("recentFiles.daysAgo", { count: days });
  }
  return new Date(timestamp).toLocaleDateString();
};

export const RecentFilesDialog: React.FC<{
  excalidrawAPI: ExcalidrawImperativeAPI;
}> = ({ excalidrawAPI }) => {
  const [open, setOpen] = useAtom(recentFilesDialogStateAtom);
  const [savedHash, setSavedHash] = useAtom(savedSceneHashAtom);

  const [entries, setEntries] = useState<RecentFileEntry[]>([]);
  // file the user picked while the current scene has unsaved changes
  const [pendingEntry, setPendingEntry] = useState<RecentFileEntry | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const refreshEntries = useCallback(async () => {
    setEntries(await getRecentFiles());
  }, []);

  useEffect(() => {
    if (open) {
      setPendingEntry(null);
      refreshEntries();
    }
  }, [open, refreshEntries]);

  if (!open) {
    return null;
  }

  const close = () => {
    setPendingEntry(null);
    setOpen(false);
  };

  /** Does the current scene have changes not yet written to its file? */
  const isSceneDirty = (): boolean => {
    const elements = excalidrawAPI.getSceneElements();
    const { fileHandle } = excalidrawAPI.getAppState();
    if (fileHandle) {
      return savedHash !== null && hashElementsVersion(elements) !== savedHash;
    }
    // never saved to a local file yet — treat any content as worth protecting
    return elements.length > 0;
  };

  const loadEntry = async (entry: RecentFileEntry) => {
    setBusy(true);
    try {
      if (!(await ensureReadPermission(entry.handle))) {
        excalidrawAPI.setToast({
          message: t("recentFiles.permissionDenied"),
          closable: true,
        });
        return;
      }

      const file = await entry.handle.getFile();
      const data = await loadFromBlob(
        file,
        excalidrawAPI.getAppState(),
        null,
        entry.handle,
      );

      excalidrawAPI.updateScene({
        elements: data.elements,
        appState: data.appState,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      if (data.files) {
        excalidrawAPI.addFiles(Object.values(data.files));
      }
      excalidrawAPI.scrollToContent(data.elements, {
        fitToContent: true,
        animate: false,
      });

      // the loaded scene now matches the file on disk
      setSavedHash(hashElementsVersion(excalidrawAPI.getSceneElements()));
      await addRecentFile(entry.handle);
      close();
    } catch (error) {
      console.error("Failed to open recent file", error);
      excalidrawAPI.setToast({
        message: t("recentFiles.openError"),
        closable: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const onEntryClick = (entry: RecentFileEntry) => {
    if (isSceneDirty()) {
      setPendingEntry(entry);
    } else {
      loadEntry(entry);
    }
  };

  const onRemove = async (id: string) => {
    await removeRecentFile(id);
    await refreshEntries();
  };

  const onClearAll = async () => {
    await clearRecentFiles();
    await refreshEntries();
  };

  const onSaveAndOpen = async () => {
    if (!pendingEntry) {
      return;
    }
    setBusy(true);
    try {
      const appState = excalidrawAPI.getAppState();
      const { fileHandle } = await saveAsJSON({
        data: {
          elements: excalidrawAPI.getSceneElements(),
          appState,
          files: excalidrawAPI.getFiles(),
        },
        filename: excalidrawAPI.getName(),
        fileHandle: appState.fileHandle,
      });
      // record a freshly-saved (previously untitled) file in recents too
      if (fileHandle) {
        await addRecentFile(fileHandle);
      }
    } catch (error: any) {
      // user dismissed the OS save picker — abort the switch, stay put
      if (error?.name === "AbortError") {
        setBusy(false);
        return;
      }
      console.error("Failed to save before switching files", error);
      excalidrawAPI.setToast({
        message: t("recentFiles.saveError"),
        closable: true,
      });
      setBusy(false);
      return;
    }
    setBusy(false);
    const entry = pendingEntry;
    setPendingEntry(null);
    await loadEntry(entry);
  };

  if (pendingEntry) {
    return (
      <Dialog
        size="small"
        onCloseRequest={() => !busy && setPendingEntry(null)}
        title={t("recentFiles.unsavedTitle")}
      >
        <div className="RecentFiles__confirm">
          <p>
            {t("recentFiles.unsavedChanges", {
              name: excalidrawAPI.getName(),
            })}
          </p>
          <div className="RecentFiles__confirm-actions">
            <FilledButton
              color="primary"
              label={t("recentFiles.saveAndOpen")}
              onClick={onSaveAndOpen}
            >
              {t("recentFiles.saveAndOpen")}
            </FilledButton>
            <FilledButton
              variant="outlined"
              color="danger"
              label={t("recentFiles.openWithoutSaving")}
              onClick={() => {
                const entry = pendingEntry;
                setPendingEntry(null);
                loadEntry(entry);
              }}
            >
              {t("recentFiles.openWithoutSaving")}
            </FilledButton>
            <FilledButton
              variant="outlined"
              color="muted"
              label={t("recentFiles.cancel")}
              onClick={() => setPendingEntry(null)}
            >
              {t("recentFiles.cancel")}
            </FilledButton>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog size="small" onCloseRequest={close} title={t("recentFiles.title")}>
      <div className="RecentFiles">
        {entries.length === 0 ? (
          <div className="RecentFiles__empty">{t("recentFiles.empty")}</div>
        ) : (
          <>
            <ul className="RecentFiles__list">
              {entries.map((entry) => (
                <li key={entry.id} className="RecentFiles__item">
                  <button
                    type="button"
                    className="RecentFiles__open"
                    disabled={busy}
                    onClick={() => onEntryClick(entry)}
                    title={entry.name}
                  >
                    <span className="RecentFiles__icon">{LoadIcon}</span>
                    <span className="RecentFiles__name">{entry.name}</span>
                    <span className="RecentFiles__time">
                      {formatRelativeTime(entry.lastOpened)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="RecentFiles__remove"
                    aria-label={t("recentFiles.remove")}
                    title={t("recentFiles.remove")}
                    disabled={busy}
                    onClick={() => onRemove(entry.id)}
                  >
                    {TrashIcon}
                  </button>
                </li>
              ))}
            </ul>
            <div className="RecentFiles__footer">
              <button
                type="button"
                className="RecentFiles__clear"
                disabled={busy}
                onClick={onClearAll}
              >
                {t("recentFiles.clearAll")}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
};
