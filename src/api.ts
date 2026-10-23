// Typisierte Schnittstelle zum Rust-Backend.
import { invoke } from "@tauri-apps/api/core";

export type Settings = {
  language: "de" | "en";
  theme: "dark" | "midnight" | "light";
  accent: string;
  animations: boolean;
  startPage: string;
  startBehavior: "startPage" | "last";
  windowMode: "normal" | "maximized";
  libraryPath: string | null;
  scanOnStart: boolean;
  watchFolders: boolean;
  scanIntervalMinutes: number;
  excludedPaths: string[];
  duplicateHandling: "versions" | "ignore";
  unrecognizedHandling: "unsorted" | "ignore";
  missingDriveBehavior: "keep" | "hide";
  fileMode: "reference" | "copy" | "move";
  autoRename: boolean;
  namingScheme: string;
  seasonFolders: boolean;
  previewFileOps: boolean;
  conflictPolicy: "skip" | "rename";
  backupBeforeChanges: boolean;
  defaultVolume: number;
  defaultSpeed: number;
  autoResume: boolean;
  autoNext: boolean;
  endBehavior: "countdown" | "next" | "stop";
  nextCountdownSeconds: number;
  markWatchedPercent: number;
  subtitleSize: number;
  subtitleColor: string;
  subtitleBackground: boolean;
  preferredAudioLang: string;
  preferredSubtitleLang: string;
  playerWindowMode: "window" | "fullscreen";
  generateThumbnails: boolean;
  shortcuts: Record<string, string>;
  autoMetadata: boolean;
  titleLanguage: "romaji" | "english" | "native";
  coverQuality: "extraLarge" | "large" | "medium";
  telemetry: boolean;
};

export type Source = {
  id: string;
  path: string;
  kind: "source" | "library";
  enabled: boolean;
  available: boolean;
  addedAt: string | null;
  lastScanAt: string | null;
  episodeCount: number;
};

export type Series = {
  id: string;
  title: string;
  altTitle: string | null;
  description: string | null;
  year: number | null;
  genres: string[];
  coverPath: string | null;
  bannerPath: string | null;
  favorite: boolean;
  sortIndex: number | null;
  anilistId: number | null;
  metadataStatus: "pending" | "matched" | "notfound";
  metadataLocked: boolean;
  format: string | null;
  score: number | null;
  studio: string | null;
  totalEpisodes: number | null;
  episodeCount: number;
  availableCount: number;
  unavailableCount: number;
  watchedCount: number;
  inProgressCount: number;
  seasonCount: number;
  lastPlayedAt: string | null;
  lastAddedAt: string | null;
  createdAt: string;
  updatedAt: string;
  onlineProvider: string | null;
};

export type EpisodeKind = "episode" | "special" | "ova" | "movie" | "extra";

export type Episode = {
  id: string;
  seriesId: string | null;
  seriesTitle: string | null;
  filePath: string;
  originPath: string | null;
  fileName: string;
  fileSize: number;
  fileMtime: number;
  sourceId: string | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  kind: EpisodeKind;
  title: string | null;
  resolution: string | null;
  audioHints: string[];
  subtitleHints: string[];
  version: number | null;
  parsedSeries: string | null;
  confidence: number;
  manual: boolean;
  sortIndex: number | null;
  available: boolean;
  missing: boolean;
  missingSince: string | null;
  ignored: boolean;
  duration: number | null;
  position: number;
  watched: boolean;
  watchedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  thumbnailPath: string | null;
  addedAt: string;
};

export type ScanProgress = {
  running: boolean;
  phase: "discover" | "process" | "verify" | "done" | "cancelled" | "error";
  trigger: string;
  currentSource: string | null;
  currentPath: string | null;
  filesFound: number;
  processed: number;
  added: number;
  updated: number;
  moved: number;
  missing: number;
  unsorted: number;
  unavailableSources: string[];
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  cancelled: boolean;
};

export type Bootstrap = {
  settings: Settings;
  sources: Source[];
  scanning: boolean;
  scan: ScanProgress | null;
  version: string;
  dataDir: string;
  databasePath: string;
  unsortedCount: number;
  unavailableCount: number;
};

export type SeriesLink = { id: string; seriesId: string; url: string; provider: string; providerName: string; source: "user" | "anilist" };
export type LinkInfo = { url: string; provider: string; providerName: string; title: string | null };

export type SeriesDetail = {
  series: Series;
  episodes: Episode[];
  seasonNames: Record<string, string>;
  folders: string[];
  links: SeriesLink[];
};

export type ContinueItem = { series: Series; episode: Episode };

export type SubtitleTrack = {
  id: string;
  label: string;
  language: string | null;
  source: "external" | "embedded";
  codec: string;
  supported: boolean;
  default: boolean;
};

export type PlaybackInfo = {
  episode: Episode;
  series: Series | null;
  previousId: string | null;
  nextId: string | null;
  next: Episode | null;
  subtitles: SubtitleTrack[];
};

export type AnimeMatch = {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  synonyms: string[];
  description: string | null;
  year: number | null;
  genres: string[];
  coverExtraLarge: string | null;
  coverLarge: string | null;
  coverMedium: string | null;
  banner: string | null;
  episodes: number | null;
  format: string | null;
  score: number | null;
  studio: string | null;
  popularity?: number | null;
  streamingLinks?: string[];
};

export type DiscoverEpisode = { number: number; title: string | null; thumbnail: string | null; url: string | null; site: string | null };
export type DiscoverDetail = { total: number | null; aired: number | null; status: string | null; episodes: DiscoverEpisode[] };

export type FileProperties = {
  fileName: string;
  path: string;
  folder: string;
  exists: boolean;
  size: number | null;
  format: string;
  mime: string;
  created: string | null;
  modified: string | null;
  containerDuration: number | null;
  tracks: { kind: string; codec: string; language: string | null; name: string | null; detail: string | null }[];
  originPath: string | null;
};

export type PlannedOp = {
  episodeId: string;
  seriesTitle: string;
  from: string;
  to: string;
  size: number;
  status: "ok" | "exists" | "same" | "duplicate" | "unavailable" | "unassigned";
};

export type Plan = { mode: "copy" | "move"; libraryPath: string; ops: PlannedOp[]; totalSize: number; conflictPolicy: string };

export type OpProgress = {
  running: boolean;
  mode: string;
  total: number;
  done: number;
  skipped: number;
  failed: string[];
  current: string | null;
  backup: string | null;
};

export type PluginManifest = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  main?: string;
  /** "python" für Python-Plugins (sonst anhand der Endung von main erkannt) */
  runtime?: "js" | "python";
  /** Pfad zu python.exe (optional) */
  python?: string;
  styles?: string[];
  defaultEnabled?: boolean;
  homepage?: string;
  settings?: PluginSettingField[];
  [k: string]: unknown;
};
export type PluginSettingField = {
  key: string;
  label: string;
  type: "boolean" | "string" | "number" | "select" | "text";
  default?: unknown;
  description?: string;
  options?: [string, string][] | string[];
};
export type InstalledPlugin = { id: string; dir: string; manifest: PluginManifest; error: string | null };
export type PluginOverview = { dir: string; plugins: InstalledPlugin[]; states: Record<string, boolean> };
export type HttpResponse = { status: number; headers: Record<string, string>; body: string };

export type DuplicateGroup = { reason: "sameFile" | "sameEpisode"; episodes: Episode[] };

export const api = {
  bootstrap: () => invoke<Bootstrap>("get_bootstrap"),
  listSeries: () => invoke<Series[]>("list_series"),
  seriesDetail: (id: string) => invoke<SeriesDetail>("get_series_detail", { id }),
  continueWatching: (limit?: number) => invoke<ContinueItem[]>("get_continue_watching", { limit }),
  listEpisodes: (filter: string, limit?: number) => invoke<Episode[]>("list_episodes", { filter, limit }),
  search: (query: string) => invoke<{ series: Series[]; episodes: Episode[] }>("search", { query }),
  setFavorite: (id: string, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  updateSeries: (id: string, patch: Record<string, unknown>) => invoke<void>("update_series", { id, patch }),
  createSeries: (title: string) => invoke<string>("create_series", { title }),
  removeSeries: (id: string, mode: "unsort" | "hide") => invoke<void>("remove_series", { id, mode }),
  mergeSeries: (sourceId: string, targetId: string) => invoke<void>("merge_series", { sourceId, targetId }),
  setSeriesImage: (id: string, kind: "cover" | "banner", path: string) => invoke<string>("set_series_image", { id, kind, path }),
  resetSeriesImage: (id: string, kind: "cover" | "banner") => invoke<void>("reset_series_image", { id, kind }),
  reorderSeries: (ids: string[]) => invoke<void>("reorder_series", { ids }),
  setSeasonName: (seriesId: string, season: number, title: string | null) => invoke<void>("set_season_name", { seriesId, season, title }),
  assignEpisodes: (req: {
    episodeIds: string[];
    seriesId?: string | null;
    newSeriesTitle?: string | null;
    season?: number | null;
    startEpisode?: number | null;
    kind?: string | null;
    rememberFolders: boolean;
  }) => invoke<string>("assign_episodes", { req }),
  updateEpisode: (id: string, patch: Record<string, unknown>) => invoke<void>("update_episode", { id, patch }),
  moveEpisodesToSeason: (ids: string[], season: number | null, kind: string) => invoke<void>("move_episodes_to_season", { ids, season, kind }),
  reorderEpisodes: (ids: string[]) => invoke<void>("reorder_episodes", { ids }),
  unassignEpisodes: (ids: string[]) => invoke<void>("unassign_episodes", { ids }),
  hideEpisodes: (ids: string[]) => invoke<void>("hide_episodes", { ids }),
  restoreEpisodes: (ids: string[]) => invoke<void>("restore_episodes", { ids }),
  forgetEpisodes: (ids: string[]) => invoke<number>("forget_episodes", { ids }),
  deleteEpisodeFile: (id: string, confirmFileName: string) => invoke<void>("delete_episode_file", { id, confirmFileName }),
  findDuplicates: () => invoke<DuplicateGroup[]>("find_duplicates"),
  playback: (id: string) => invoke<PlaybackInfo>("get_playback", { id }),
  saveProgress: (id: string, position: number, duration: number | null, finished: boolean) =>
    invoke<boolean>("save_progress", { id, position, duration, finished }),
  markWatched: (ids: string[], watched: boolean) => invoke<void>("mark_watched", { ids, watched }),
  markSeriesWatched: (seriesId: string, watched: boolean) => invoke<void>("mark_series_watched", { seriesId, watched }),
  saveThumbnail: (id: string, data: string, duration: number | null) => invoke<string>("save_thumbnail", { id, data, duration }),
  subtitle: (episodeId: string, track: string) => invoke<string>("get_subtitle", { episodeId, track }),
  loadSubtitleFile: (path: string) => invoke<string>("load_subtitle_file", { path }),
  openDefault: (id: string) => invoke<void>("open_in_default_player", { id }),
  reveal: (id: string) => invoke<void>("reveal_in_explorer", { id }),
  openEpisodeFolder: (id: string) => invoke<void>("open_episode_folder", { id }),
  openSeriesFolder: (id: string) => invoke<void>("open_series_folder", { id }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  fileProperties: (id: string) => invoke<FileProperties>("file_properties", { id }),
  addSource: (path: string, scan: boolean) => invoke<Source>("add_source", { path, scan }),
  removeSource: (id: string, removeEntries: boolean) => invoke<void>("remove_source", { id, removeEntries }),
  setSourceEnabled: (id: string, enabled: boolean) => invoke<void>("set_source_enabled", { id, enabled }),
  listSources: () => invoke<Source[]>("list_sources"),
  addSeriesLink: (seriesId: string, url: string) => invoke<void>("add_series_link", { seriesId, url }),
  removeSeriesLink: (id: string) => invoke<void>("remove_series_link", { id }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  inspectLink: (url: string) => invoke<LinkInfo>("inspect_link", { url }),
  createSeriesFromLink: (url: string, title: string) => invoke<string>("create_series_from_link", { url, title }),
  startScan: (sourceIds?: string[]) => invoke<void>("start_scan", { sourceIds }),
  cancelScan: () => invoke<void>("cancel_scan"),
  addFiles: (paths: string[], seriesId?: string) => invoke<{ added: number; skipped: number }>("add_files", { paths, seriesId }),
  metadataSearch: (query: string) => invoke<AnimeMatch[]>("metadata_search", { query }),
  metadataApply: (seriesId: string, item: AnimeMatch, rename: boolean) => invoke<void>("metadata_apply", { seriesId, item, rename }),
  metadataRefresh: (seriesIds: string[] | null, includeMatched: boolean) => invoke<void>("metadata_refresh", { seriesIds, includeMatched }),
  discoverEpisodes: (anilistId: number) => invoke<DiscoverDetail>("discover_episodes", { anilistId }),
  discoverAdd: (item: AnimeMatch) => invoke<string>("discover_add", { item }),
  metadataClear: (seriesId: string) => invoke<void>("metadata_clear", { seriesId }),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  resetSettings: () => invoke<Settings>("reset_settings"),
  planFileOperation: (req: { seriesIds?: string[]; episodeIds?: string[]; mode: "copy" | "move"; onlyOutside?: boolean }) =>
    invoke<Plan>("plan_file_operation", { req }),
  executeFileOperation: (mode: string, ops: PlannedOp[]) => invoke<void>("execute_file_operation", { mode, ops }),
  countOutsideLibrary: () => invoke<number>("count_outside_library"),
  createBackup: (path?: string) => invoke<string>("create_backup", { path }),
  restoreBackup: (path: string) => invoke<void>("restore_backup", { path }),
  listBackups: () => invoke<{ path: string; name: string; size: number | null }[]>("list_backups"),
  exportLibrary: (path: string) => invoke<void>("export_library", { path }),
  importLibrary: (path: string) => invoke<number>("import_library", { path }),
  clearCache: (kind: "metadata" | "thumbnails" | "subtitles") => invoke<void>("clear_cache", { kind }),
  readLogs: () => invoke<string>("read_logs"),
  diagnostics: () => invoke<Record<string, any>>("diagnostics"),
  moveDatabase: (dir: string) => invoke<string>("move_database", { dir }),
  resetDatabaseLocation: () => invoke<void>("reset_database_location"),
  restart: () => invoke<void>("restart_app"),
  pluginList: () => invoke<PluginOverview>("plugin_list"),
  pluginSetEnabled: (id: string, enabled: boolean) => invoke<void>("plugin_set_enabled", { id, enabled }),
  pluginReadFile: (id: string, path: string) => invoke<string>("plugin_read_file", { id, path }),
  pluginInstall: (path: string) => invoke<string>("plugin_install", { path }),
  pluginUninstall: (id: string) => invoke<void>("plugin_uninstall", { id }),
  pluginCreate: (name: string, lang: "js" | "py" = "js") => invoke<string>("plugin_create", { name, lang }),
  pluginPyStart: (id: string, main: string, python?: string) => invoke<string>("plugin_py_start", { id, main, python }),
  pluginPySend: (id: string, line: string) => invoke<void>("plugin_py_send", { id, line }),
  pluginPyStop: (id: string) => invoke<void>("plugin_py_stop", { id }),
  pluginStorageGet: (id: string) => invoke<Record<string, unknown>>("plugin_storage_get", { id }),
  pluginStorageSet: (id: string, key: string, value: unknown) => invoke<void>("plugin_storage_set", { id, key, value: value ?? null }),
  pluginHttp: (req: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) =>
    invoke<HttpResponse>("plugin_http", { req }),
  pluginFsRead: (path: string) => invoke<string>("plugin_fs_read", { path }),
  pluginFsWrite: (path: string, content: string, append?: boolean) => invoke<void>("plugin_fs_write", { path, content, append }),
  pluginFsList: (path: string) => invoke<{ name: string; path: string; isDir: boolean; size: number }[]>("plugin_fs_list", { path }),
  pluginFsExists: (path: string) => invoke<boolean>("plugin_fs_exists", { path }),
  pluginRun: (program: string, args: string[], cwd?: string, wait?: boolean) =>
    invoke<{ code: number | null; stdout: string; stderr: string }>("plugin_run", { program, args, cwd, wait }),
  pluginSql: (sql: string, params?: unknown[]) => invoke<any>("plugin_sql", { sql, params }),
  log: (level: string, message: string) => invoke<void>("log_frontend", { level, message }).catch(() => {}),
};

const ORIGIN = "http://nexus.localhost";
export const imageUrl = (rel: string | null | undefined, v?: string) => (rel ? `${ORIGIN}/img/${rel}${v ? `?v=${encodeURIComponent(v)}` : ""}` : null);
export const videoUrl = (id: string) => `${ORIGIN}/video/${id}`;

export const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
