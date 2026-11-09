import {copyFile, mkdir, readFile, rename, rm, stat} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {atomicWriteJson, atomicWriteText, ensureDir, readJsonIfExists} from "./io.mjs";
import {installRendererAssets, renderMonthlyDocument} from "./page-renderer.mjs";
import {assertAssetContract, inspectImageAsset, normalizeAsset} from "./asset-contract.mjs";
import {preparePortableSharePrompt} from "./portable-export.mjs";
import {validateRenderedHtmlText} from "./validate-rendered-html.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function monthKey(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})/u);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  return validateMonth(`${match[1]}-${match[2]}`);
}

export function validateMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new Error(`Invalid month: ${value}; expected YYYY-MM`);
  }
  return value;
}

function safeSegment(value, label) {
  const segment = String(value ?? "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)
    || segment === "."
    || segment === ".."
  ) {
    throw new Error(`${label} must be a safe file segment`);
  }
  return segment;
}

function safeImageExtension(source) {
  const extension = path.extname(source).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"].includes(extension)) {
    throw new Error(`Unsupported page image extension: ${extension || "(none)"}`);
  }
  return extension;
}

function bookPaths(root, bookId) {
  const book = path.join(root, "books", safeSegment(bookId, "bookId"));
  return {
    book,
    seriesManifest: path.join(book, "series-manifest.json"),
    seriesIndex: path.join(book, "index.html"),
    episodes: path.join(book, "episodes"),
    monthlyVolumes: path.join(book, "monthly-volumes"),
    parts: path.join(book, "parts"),
    annuals: path.join(book, "annuals"),
    locks: path.join(root, "runtime", "locks"),
    quarantine: path.join(root, "runtime", "quarantine")
  };
}

function volumePaths(root, bookId, month) {
  const base = path.join(
    bookPaths(root, bookId).monthlyVolumes,
    validateMonth(month)
  );
  return {
    base,
    manifest: path.join(base, "volume-manifest.json"),
    edition: path.join(base, "continuous-edition"),
    index: path.join(base, "continuous-edition", "index.html"),
    data: path.join(base, "continuous-edition", "book-data.json")
  };
}

async function initialize(root, bookId, title) {
  const locations = bookPaths(root, bookId);
  await Promise.all([
    ensureDir(locations.episodes),
    ensureDir(locations.monthlyVolumes),
    ensureDir(locations.parts),
    ensureDir(locations.annuals),
    ensureDir(locations.locks),
    ensureDir(locations.quarantine)
  ]);
  const existing = await readJsonIfExists(locations.seriesManifest);
  if (!existing) {
    await atomicWriteJson(locations.seriesManifest, {
      schemaVersion: "1.0.0",
      bookId,
      title,
      nextEpisodeNumber: 1,
      months: [],
      parts: [],
      annuals: [],
      idempotency: {},
      updatedAt: null
    });
  }
  return locations;
}

async function acquireLock(root, bookId, options = {}) {
  const {waitMs = 10_000, leaseMs = 15_000, pollMs = 20} = options;
  const locations = bookPaths(root, bookId);
  // Only prepare lock infrastructure here. Book files must be initialized by
  // the lock owner, otherwise first-time writers can race on Windows rename.
  await Promise.all([
    ensureDir(locations.locks),
    ensureDir(locations.quarantine)
  ]);
  const lockDirectory = path.join(
    locations.locks,
    `${safeSegment(bookId, "bookId")}.lock`
  );
  const token = randomUUID();
  const startedAt = Date.now();

  while (Date.now() - startedAt <= waitMs) {
    try {
      await mkdir(lockDirectory, {recursive: false});
      await atomicWriteJson(path.join(lockDirectory, "owner.json"), {
        token,
        createdAt: new Date().toISOString()
      });
      return {lockDirectory, token};
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDirectory);
        if (Date.now() - info.mtimeMs > leaseMs) {
          await rename(
            lockDirectory,
            path.join(locations.quarantine, `stale-${bookId}-${randomUUID()}`)
          );
          continue;
        }
      } catch (statError) {
        if (!["ENOENT", "EEXIST"].includes(statError?.code)) throw statError;
      }
      await wait(pollMs);
    }
  }
  throw new Error(`Timed out waiting for book lock: ${bookId}`);
}

async function releaseLock(lock) {
  const owner = await readJsonIfExists(path.join(lock.lockDirectory, "owner.json"));
  if (owner?.token === lock.token) {
    await rm(lock.lockDirectory, {recursive: true, force: true});
  }
}

function resolvePlacement(episode) {
  const recordedAt = episode.recordedAt;
  const eventDate = episode.eventDate ?? recordedAt;
  const placementDate = episode.placement === "current-reflection"
    ? recordedAt
    : eventDate;
  return {
    month: monthKey(placementDate),
    displayDate: placementDate,
    eventDate,
    recordedAt
  };
}

function sortEpisodes(episodes) {
  return [...episodes].sort((left, right) => {
    const date = left.displayDate.localeCompare(right.displayDate);
    return date || left.episodeNumber - right.episodeNumber;
  });
}

function readableDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) return value;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function readableMonth(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})$/u);
  if (!match) return value;
  return `${match[1]}年${Number(match[2])}月`;
}

function partKey(month) {
  const match = String(month ?? "").match(/^(\d{4})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid month: ${month}`);
  const quarter = Math.floor((Number(match[2]) - 1) / 3) + 1;
  return `${match[1]}-Q${quarter}`;
}

function partLabel(value) {
  const match = String(value ?? "").match(/^(\d{4})-Q([1-4])$/u);
  if (!match) return value;
  return `${match[1]}年 · 第${match[2]}部`;
}

function routeLabel(value) {
  return {
    S: "日常",
    P: "照片",
    K: "知识",
    M: "会议",
    L: "长文"
  }[value] ?? value;
}

function renderSeriesHtml(series) {
  const months = series.months.map((month) => `
    <li><a href="${escapeHtml(month.href)}">${escapeHtml(readableMonth(month.month))}</a><span>${month.episodeCount} 章</span></li>
  `).join("\n");
  const parts = (series.parts ?? []).map((part) => `
    <li><a href="${escapeHtml(part.href)}">${escapeHtml(partLabel(part.part))}</a><span>${part.months.length} 册</span></li>
  `).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(series.title)}</title>
<style>body{margin:auto;max-width:820px;padding:8vw 24px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#243140}h1{font-size:clamp(36px,8vw,72px)}li{display:flex;justify-content:space-between;padding:22px 0;border-bottom:1px solid #dbe6f2}a{color:#426b96;font-size:22px}</style>
</head><body><h1>${escapeHtml(series.title)}</h1><p>一本持续生长的漫画人生</p><h2>月册</h2><ol>${months}</ol><h2>部</h2><ol>${parts}</ol></body></html>`;
}

function renderCollectionHtml({title, subtitle, months}) {
  const items = months.map((month) => `
    <li><a href="../../${escapeHtml(month.href)}">${escapeHtml(readableMonth(month.month))}</a><span>${month.episodeCount} 章</span></li>
  `).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:auto;max-width:820px;padding:8vw 24px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#243140}h1{font-size:clamp(36px,8vw,72px)}li{display:flex;justify-content:space-between;padding:22px 0;border-bottom:1px solid #dbe6f2}a{color:#426b96;font-size:22px}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><ol>${items}</ol></body></html>`;
}

async function updateCollectionIndexes(locations, series) {
  const parts = new Map();
  const annuals = new Map();
  for (const month of series.months) {
    const part = partKey(month.month);
    const year = month.month.slice(0, 4);
    if (!parts.has(part)) parts.set(part, []);
    if (!annuals.has(year)) annuals.set(year, []);
    parts.get(part).push(month);
    annuals.get(year).push(month);
  }

  series.parts = [];
  for (const [part, months] of [...parts].sort(([left], [right]) => left.localeCompare(right))) {
    const directory = path.join(locations.parts, part);
    await ensureDir(directory);
    await atomicWriteJson(path.join(directory, "index.json"), {
      schemaVersion: "1.0.0",
      part,
      months
    });
    await atomicWriteText(path.join(directory, "index.html"), renderCollectionHtml({
      title: partLabel(part),
      subtitle: "自然季度索引；正文仍由月册承载。",
      months
    }));
    series.parts.push({
      part,
      href: `parts/${part}/index.html`,
      months: months.map((item) => item.month)
    });
  }

  series.annuals = [];
  for (const [year, months] of [...annuals].sort(([left], [right]) => left.localeCompare(right))) {
    const directory = path.join(locations.annuals, year);
    await ensureDir(directory);
    await atomicWriteJson(path.join(directory, "index.json"), {
      schemaVersion: "1.0.0",
      year,
      months
    });
    await atomicWriteText(path.join(directory, "index.html"), renderCollectionHtml({
      title: `${year} 年度合辑`,
      subtitle: "年度索引；不复制月册正文。",
      months
    }));
    series.annuals.push({
      year,
      href: `annuals/${year}/index.html`,
      months: months.map((item) => item.month)
    });
  }
}

export async function appendEpisode(root, rawEpisode) {
  const episode = {
    bookId: rawEpisode.bookId,
    bookTitle: rawEpisode.bookTitle ?? "我的漫画人生",
    idempotencyKey: rawEpisode.idempotencyKey,
    episodeId: rawEpisode.episodeId ?? randomUUID(),
    title: rawEpisode.title ?? "今天一页",
    text: rawEpisode.text ?? "",
    route: rawEpisode.route ?? "S",
    recordedAt: rawEpisode.recordedAt,
    eventDate: rawEpisode.eventDate ?? rawEpisode.recordedAt,
    placement: rawEpisode.placement ?? "event-date",
    visualStatus: rawEpisode.visualStatus ?? "ready",
    coverDirection: rawEpisode.coverDirection ?? null,
    visualLayout: rawEpisode.visualLayout ?? null,
    style: rawEpisode.style ?? null,
    styleId: rawEpisode.styleId ?? rawEpisode.style?.id ?? "02-snow-pastel",
    palette: rawEpisode.palette ?? null,
    paletteSource: rawEpisode.paletteSource ?? null
  };
  if (!episode.bookId || !episode.idempotencyKey || !episode.recordedAt) {
    throw new Error("bookId, idempotencyKey and recordedAt are required");
  }
  safeSegment(episode.bookId, "bookId");
  safeSegment(episode.episodeId, "episodeId");

  const lock = await acquireLock(root, episode.bookId);
  let lockHeld = true;
  try {
    const locations = await initialize(root, episode.bookId, episode.bookTitle);
    const series = await readJsonIfExists(locations.seriesManifest);
    const existingId = series.idempotency[episode.idempotencyKey];
    if (existingId) {
      await releaseLock(lock);
      lockHeld = false;
      return {
        episodeId: existingId,
        reused: true,
        portableShare: await preparePortableSharePrompt(root, {
          bookId: episode.bookId,
          unit: "chapter",
          key: existingId
        })
      };
    }

    const placement = resolvePlacement(episode);
    const volumeLocations = volumePaths(root, episode.bookId, placement.month);
    await ensureDir(volumeLocations.edition);
    const pageAssets = [];
    const assetRoot = path.join(volumeLocations.edition, "assets");
    const finalAssetDirectory = path.join(assetRoot, episode.episodeId);
    const stagedAssetDirectory = path.join(
      assetRoot,
      `.staging-${episode.episodeId}-${randomUUID()}`
    );
    try {
      await ensureDir(stagedAssetDirectory);
      const suppliedAsVisuals = Array.isArray(rawEpisode.visuals);
      const suppliedVisuals = rawEpisode.visuals ?? rawEpisode.pages ?? [];
      for (const [index, page] of suppliedVisuals.entries()) {
        const source = typeof page === "string" ? page : page.path;
        if (!source) throw new Error(`Missing page path at index ${index}`);
        const intrinsic = await inspectImageAsset(source);
        const filename = `${String(index + 1).padStart(2, "0")}${safeImageExtension(source)}`;
        await copyFile(source, path.join(stagedAssetDirectory, filename));
        const normalized = normalizeAsset({
          src: path.posix.join("assets", episode.episodeId, filename),
          alt: typeof page === "string"
            ? `${episode.title} 第 ${index + 1} 页`
            : page.alt ?? `${episode.title} 第 ${index + 1} 页`,
          role: typeof page === "string"
            ? (index === 0 ? "cover-visual" : "body-visual")
            : page.role ?? (index === 0 ? "cover-visual" : "body-visual"),
          kind: typeof page === "string"
            ? (suppliedAsVisuals ? "textless-visual" : "rendered-page")
            : page.kind ?? (suppliedAsVisuals ? "textless-visual" : "rendered-page"),
          ...(typeof page === "string" ? {} : page),
          detectedFormat: intrinsic.format,
          transparencyStatus: intrinsic.transparencyStatus
        }, intrinsic, {assetId: `${episode.episodeId}-${index + 1}`});
        normalized.src = path.posix.join("assets", episode.episodeId, filename);
        delete normalized.path;
        assertAssetContract(normalized);
        pageAssets.push(normalized);
      }
      await rename(stagedAssetDirectory, finalAssetDirectory);
    } catch (error) {
      await rm(stagedAssetDirectory, {recursive: true, force: true});
      throw error;
    }

    const committed = {
      ...episode,
      ...placement,
      pageAssets,
      episodeNumber: series.nextEpisodeNumber,
      committedAt: new Date().toISOString()
    };
    await atomicWriteJson(
      path.join(locations.episodes, `${committed.episodeId}.json`),
      committed
    );

    const volume = await readJsonIfExists(volumeLocations.manifest, {
      schemaVersion: "1.0.0",
      bookId: episode.bookId,
      month: placement.month,
      episodes: []
    });
    if (rawEpisode.monthlyCover?.path) {
      const source = rawEpisode.monthlyCover.path;
      const intrinsic = await inspectImageAsset(source);
      const monthCoverDirectory = path.join(assetRoot, "monthly-cover");
      await ensureDir(monthCoverDirectory);
      const filename = `${placement.month}${safeImageExtension(source)}`;
      await copyFile(source, path.join(monthCoverDirectory, filename));
      volume.coverAsset = normalizeAsset({
        ...rawEpisode.monthlyCover,
        src: path.posix.join("assets", "monthly-cover", filename),
        role: "monthly-cover",
        independent: true,
        allowCrop: false,
        detectedFormat: intrinsic.format,
        transparencyStatus: intrinsic.transparencyStatus
      }, intrinsic, {assetId: `monthly-cover-${placement.month}`});
      delete volume.coverAsset.path;
      assertAssetContract(volume.coverAsset);
      volume.styleId = rawEpisode.monthlyCover.styleId ?? episode.styleId;
      volume.palette = rawEpisode.monthlyCover.palette ?? episode.palette;
      volume.paletteSource = rawEpisode.monthlyCover.paletteSource ?? episode.paletteSource;
    }
    volume.episodes = sortEpisodes([...volume.episodes, committed]);
    volume.updatedAt = committed.committedAt;
    await atomicWriteJson(volumeLocations.manifest, volume);
    await atomicWriteJson(volumeLocations.data, {
      bookId: episode.bookId,
      month: placement.month,
      episodes: volume.episodes
    });
    await installRendererAssets(volumeLocations.edition);
    const renderedHtml = renderMonthlyDocument({title: series.title}, volume);
    const renderedValidation = validateRenderedHtmlText(renderedHtml);
    if (renderedValidation.status !== "PASS") {
      throw new Error(`Rendered HTML rejected: ${renderedValidation.failures.join(",")}`);
    }
    await atomicWriteText(volumeLocations.index, renderedHtml);

    const monthRecord = {
      month: placement.month,
      href: `monthly-volumes/${placement.month}/continuous-edition/index.html`,
      episodeCount: volume.episodes.length
    };
    series.months = [
      ...series.months.filter((item) => item.month !== placement.month),
      monthRecord
    ].sort((left, right) => left.month.localeCompare(right.month));
    series.idempotency[episode.idempotencyKey] = committed.episodeId;
    series.nextEpisodeNumber += 1;
    series.updatedAt = committed.committedAt;
    await updateCollectionIndexes(locations, series);
    await atomicWriteJson(locations.seriesManifest, series);
    await atomicWriteText(locations.seriesIndex, renderSeriesHtml(series));
    await releaseLock(lock);
    lockHeld = false;
    return {
      episodeId: committed.episodeId,
      episodeNumber: committed.episodeNumber,
      month: placement.month,
      reused: false,
      monthlyIndex: volumeLocations.index,
      seriesIndex: locations.seriesIndex,
      portableShare: await preparePortableSharePrompt(root, {
        bookId: episode.bookId,
        unit: "chapter",
        key: committed.episodeId
      })
    };
  } finally {
    if (lockHeld) await releaseLock(lock);
  }
}

export async function inspectSeries(root, bookId) {
  return readJsonIfExists(bookPaths(root, bookId).seriesManifest);
}

export async function inspectVolume(root, bookId, month) {
  return readJsonIfExists(volumePaths(root, bookId, month).manifest);
}

export async function readMonthlyHtml(root, bookId, month) {
  return readFile(volumePaths(root, bookId, month).index, "utf8");
}
