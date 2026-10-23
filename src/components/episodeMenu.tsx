import { Check, Copy, Edit3, EyeOff, ExternalLink, FileText, FolderInput, FolderOpen, Globe, Link2, Link2Off, Play, Trash2, Undo2 } from "lucide-react";
import { api, Episode } from "../api";
import { linkSources, resolveEpisodeLink } from "../player/linkSources";
import { MenuItem, useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, episodeTitle } from "../format";
import { pluginMenuItems, usePlugins } from "../plugins/host";
import { AssignDialog, DeleteFileDialog, EditEpisodeDialog, PropertiesDialog } from "./dialogs";

/** Liefert das Aktionsmenü einer Episode – echte Windows-Aktionen, keine Platzhalter. */
export function useEpisodeMenu(onChanged: () => void) {
  const { play, playStream, toast, fail, openDialog, series } = useStore();
  const { registry } = usePlugins();
  const run = (p: Promise<unknown>, ok?: string) =>
    p.then(() => {
      if (ok) toast("success", ok);
      onChanged();
    }).catch(fail);

  const playViaLink = (e: Episode) => {
    toast("info", t("links.searching"));
    resolveEpisodeLink(e, series.find((s) => s.id === e.seriesId) ?? null)
      .then((r) => {
        if (r.spec) playStream(r.spec);
        else toast("error", t("links.notFound"), r.tried.length ? r.tried.join("\n") : t("links.noneActive"));
      })
      .catch(fail);
  };

  return (e: Episode): MenuItem[] => {
    const playable = e.available && !e.missing;
    const hasLinks = linkSources().some((s) => s.enabled);
    const items: MenuItem[] = [
      { title: `${episodeCode(e)} · ${episodeTitle(e)}` },
      { label: t("ep.play"), icon: <Play size={16} />, onClick: () => play(e.id), disabled: !playable },
      { label: t("links.play"), icon: <Globe size={16} />, onClick: () => playViaLink(e), disabled: !hasLinks || e.episode == null },
      { label: t("ep.openDefault"), icon: <ExternalLink size={16} />, onClick: () => api.openDefault(e.id).then(onChanged).catch(fail) },
      { label: t("ep.reveal"), icon: <FolderInput size={16} />, onClick: () => api.reveal(e.id).catch(fail) },
      { label: t("ep.openFolder"), icon: <FolderOpen size={16} />, onClick: () => api.openEpisodeFolder(e.id).catch(fail) },
      {
        label: t("ep.copyPath"),
        icon: <Copy size={16} />,
        onClick: () => navigator.clipboard.writeText(e.filePath).then(() => toast("success", t("common.copied"), e.filePath)),
      },
      { label: t("ep.properties"), icon: <FileText size={16} />, onClick: () => openDialog(<PropertiesDialog episode={e} />) },
      { divider: true },
      e.watched
        ? { label: t("ep.markUnwatched"), icon: <Undo2 size={16} />, onClick: () => run(api.markWatched([e.id], false)) }
        : { label: t("ep.markWatched"), icon: <Check size={16} />, onClick: () => run(api.markWatched([e.id], true)) },
      { label: t("ep.edit"), icon: <Edit3 size={16} />, onClick: () => openDialog(<EditEpisodeDialog episode={e} onDone={onChanged} />) },
      { label: t("ep.assign"), icon: <Link2 size={16} />, onClick: () => openDialog(<AssignDialog episodes={[e]} onDone={onChanged} />) },
    ];
    if (e.seriesId) items.push({ label: t("ep.unassign"), icon: <Link2Off size={16} />, onClick: () => run(api.unassignEpisodes([e.id]), t("toast.unassigned")) });
    const extra = pluginMenuItems(registry.episodeMenu, e);
    if (extra.length) items.push({ divider: true }, ...extra);
    items.push(
      { divider: true },
      { label: t("ep.hide"), icon: <EyeOff size={16} />, onClick: () => run(api.hideEpisodes([e.id]), t("toast.hidden")) },
      { label: t("ep.deleteFile"), icon: <Trash2 size={16} />, danger: true, disabled: !playable, onClick: () => openDialog(<DeleteFileDialog episode={e} onDone={onChanged} />) },
    );
    return items;
  };
}
