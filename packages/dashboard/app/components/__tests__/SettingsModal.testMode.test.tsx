import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SETTINGS_AUTOSAVE_DEBOUNCE_MS, SettingsModal } from "../SettingsModal";

const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  });
});

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: () => ({ status: null, capabilities: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => "desktop",
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }),
}));
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));
vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({ entries: [], currentPath: ".", setPath: vi.fn(), loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: () => ({ status: "idle", requestInstall: vi.fn() }),
}));

function buildSettings(testMode: boolean) {
  return {
    autoMerge: true,
    testMode,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    heartbeatMultiplier: 1,
    groupOverlappingFiles: true,
    overlapIgnorePaths: [],
    mergeStrategy: "direct",
    mergeIntegrationWorktree: "reuse-task-worktree",
    executorAllowSiblingBranchRename: false,
    worktreesDir: "",
    worktrunk: { enabled: false, binaryPath: "", onFailure: "fail" },
    includeTaskIdInCommit: true,
    ntfyEnabled: false,
    failureNotificationMode: "sticky-only",
    failureNotificationDelayMs: 30000,
    webhookEnabled: false,
    experimentalFeatures: {},
  };
}

describe("SettingsModal testMode toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const merged = buildSettings(true);
    mockFetchSettings.mockResolvedValue(merged);
    mockFetchSettingsByScope.mockResolvedValue({ global: {}, project: { testMode: true } });
    mockUpdateSettings.mockResolvedValue({});
    mockUpdateGlobalSettings.mockResolvedValue({});
  });

  it("renders merge test mode toggle with initial checked state", async () => {
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="merge" />);

    const toggle = await screen.findByLabelText("Enable test mode");
    expect(toggle).toBeChecked();
  });

  it("flips checkbox state when clicked", async () => {
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="merge" />);

    const toggle = await screen.findByLabelText("Enable test mode");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
  });

  /*
  FNXC:SettingsScope 2026-10-07-17:59:
  The Merge toggle is a project override. Saving it from either Settings host must never call the global settings write, because a global testMode switches every inheriting project to mock and the next startup to the test database.
  */
  it.each([
    { name: "enable with global unset", global: {}, project: {}, initial: false, expected: true },
    { name: "disable an explicit project override", global: {}, project: { testMode: true }, initial: true, expected: false },
    { name: "override a conflicting global value", global: { testMode: true }, project: {}, initial: true, expected: false },
  ])("modal close saves only the project override: $name", async ({ global, project, initial, expected }) => {
    mockFetchSettings.mockResolvedValue(buildSettings(initial));
    mockFetchSettingsByScope.mockResolvedValue({ global, project });
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="merge" />);

    const toggle = await screen.findByLabelText("Enable test mode");
    fireEvent.click(toggle);
    fireEvent.click(document.querySelector(".modal-close") as HTMLButtonElement);

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ testMode: expected }), undefined);
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("embedded settings autosave writes only the project override", async () => {
    mockFetchSettings.mockResolvedValue(buildSettings(false));
    mockFetchSettingsByScope.mockResolvedValue({ global: {}, project: {} });
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="merge" presentation="embedded" />);

    const toggle = await screen.findByLabelText("Enable test mode");
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DEBOUNCE_MS);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ testMode: true }), undefined);
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });
});
