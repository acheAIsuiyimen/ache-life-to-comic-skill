import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {pathToFileURL} from "node:url";
import os from "node:os";
import path from "node:path";

import {appendEpisode, inspectSeries, inspectVolume, readMonthlyHtml} from "../../scripts/monthly-serial.mjs";

const execFileAsync = promisify(execFile);
const cli = path.resolve("scripts/cli.mjs");
const serialModule = pathToFileURL(path.resolve("scripts/monthly-serial.mjs")).href;
const invalidMonths = [
  "../outside", "..\\outside", "2026-07/../../outside", "2026-07\\..\\outside",
  "2026-00", "2026-13", "2026-1", "2026-001", "26-07", "2026-07-01",
  "2026-07suffix", "2026-07\n", " 2026-07", "", null, true
];

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ache-path-lock-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

function episode(index, overrides = {}) {
  return {
    bookId: "fresh-book",
    bookTitle: "并发创建的书",
    idempotencyKey: `entry-${index}`,
    episodeId: `episode-${index}`,
    title: `第 ${index} 次记录`,
    text: `记录 ${index}`,
    recordedAt: "2026-07-01T12:00:00+08:00",
    ...overrides
  };
}

async function assertCliRejects(args, pattern) {
  await assert.rejects(execFileAsync(process.execPath, [cli, ...args]), (error) => {
    assert.equal(error.code, 1, error.stderr);
    assert.match(error.stderr, pattern);
    assert.equal(error.stdout, "");
    return true;
  });
}

test("CLI append rejects an unsafe bookId before reading an outside profile", async (t) => {
  const root = await temporaryRoot(t);
  const library = path.join(root, "library");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  // Invalid JSON makes a premature read observable, even if validation happens later.
  await writeFile(path.join(outside, "publication-profile.json"), "not JSON");
  const input = path.join(root, "input.json");
  for (const bookId of ["../../outside", "..\\..\\outside", "../outside", "..", "/outside", "C:\\outside"]) {
    await writeFile(input, JSON.stringify(episode(1, {bookId})));
    await assertCliRejects(["append", "--library", library, "--input", input], /bookId must be a safe file segment/u);
  }
  await assert.rejects(readFile(path.join(library, "books/fresh-book/series-manifest.json")), {code: "ENOENT"});
});

test("CLI inspect validates month before reading the series or volume", async (t) => {
  const root = await temporaryRoot(t);
  const book = path.join(root, "books/fresh-book");
  await mkdir(book, {recursive: true});
  await writeFile(path.join(book, "series-manifest.json"), "not JSON");
  for (const month of invalidMonths.filter((value) => typeof value === "string")) {
    await assertCliRejects([
      "inspect", "--library", root, "--book-id", "fresh-book", "--month", month
    ], /Invalid month/u);
  }
  await assertCliRejects([
    "inspect", "--library", root, "--book-id", "fresh-book", "--month"
  ], /Invalid month/u);
});

test("core volume readers reject unsafe book ids before accessing files", async (t) => {
  const root = await temporaryRoot(t);
  for (const bookId of ["../outside", "..\\outside", "..", "/outside", "C:\\outside", ""]) {
    await assert.rejects(inspectVolume(root, bookId, "2026-07"), /bookId must be a safe file segment/u);
    await assert.rejects(readMonthlyHtml(root, bookId, "2026-07"), /bookId must be a safe file segment/u);
  }
});

test("core volume readers require an exact valid YYYY-MM", async (t) => {
  const root = await temporaryRoot(t);
  const outside = path.join(root, "books/fresh-book/outside");
  await mkdir(path.join(outside, "continuous-edition"), {recursive: true});
  await writeFile(path.join(outside, "volume-manifest.json"), JSON.stringify({outside: true}));
  await writeFile(path.join(outside, "continuous-edition/index.html"), "outside HTML");
  for (const month of invalidMonths) {
    await assert.rejects(inspectVolume(root, "fresh-book", month), /Invalid month/u);
    await assert.rejects(readMonthlyHtml(root, "fresh-book", month), /Invalid month/u);
  }
  for (const month of ["2026-01", "2026-12"]) {
    assert.equal(await inspectVolume(root, "fresh-book", month), null);
  }
});

test("append rejects out-of-range placement months", async (t) => {
  const root = await temporaryRoot(t);
  for (const month of ["00", "13"]) {
    await assert.rejects(appendEpisode(root, episode(1, {
      recordedAt: `2026-${month}-01T12:00:00+08:00`
    })), /Invalid month/u);
  }
});

test("series manifest initialization and updates happen under the book lock", async (t) => {
  const root = await temporaryRoot(t);
  // Isolate the filesystem instrumentation so no other test sees patched built-ins.
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import path from "node:path";
    import {syncBuiltinESMExports} from "node:module";
    const root = process.argv[1];
    const manifest = path.join(root, "books/fresh-book/series-manifest.json");
    const lock = path.join(root, "runtime/locks/fresh-book.lock");
    const originalRename = fs.rename;
    let manifestWrites = 0;
    fs.rename = async (source, destination) => {
      if (destination === manifest) {
        const owner = await fs.readFile(path.join(lock, "owner.json"), "utf8")
          .catch(() => assert.fail("Series manifest write occurred without book lock"));
        assert.ok(JSON.parse(owner).token);
        manifestWrites += 1;
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    const {appendEpisode, inspectSeries} = await import(process.argv[2]);
    await appendEpisode(root, ${JSON.stringify(episode(1))});
    assert.equal((await inspectSeries(root, "fresh-book")).title, "并发创建的书");
    assert.equal(manifestWrites, 2);
    await assert.rejects(fs.stat(lock), {code: "ENOENT"});
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script, root, serialModule]);
});

test("failed initialization releases the book lock", async (t) => {
  const root = await temporaryRoot(t);
  const book = path.join(root, "books/fresh-book");
  await mkdir(book, {recursive: true});
  await writeFile(path.join(book, "series-manifest.json"), "not JSON");
  await assert.rejects(appendEpisode(root, episode(1)), SyntaxError);
  assert.deepEqual(await readdir(path.join(root, "runtime/locks")), []);
});

test("ten independent CLI processes safely initialize and append to a new book", {timeout: 30_000}, async (t) => {
  const root = await temporaryRoot(t);
  const library = path.join(root, "new-library");
  const inputs = await Promise.all(Array.from({length: 10}, async (_, index) => {
    const input = path.join(root, `input-${index + 1}.json`);
    await writeFile(input, JSON.stringify(episode(index + 1)));
    return input;
  }));
  const outcomes = await Promise.allSettled(inputs.map((input) => execFileAsync(
    process.execPath, [cli, "append", "--library", library, "--input", input]
  )));
  const failures = outcomes.filter((result) => result.status === "rejected");
  assert.deepEqual(failures.map((result) => result.reason.stderr ?? result.reason.message), []);
  const results = outcomes.map((result) => JSON.parse(result.value.stdout));
  assert.deepEqual(results.map((result) => result.episodeNumber).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(results.every((result) => !result.reused));
  const series = await inspectSeries(library, "fresh-book");
  assert.equal(series.title, "并发创建的书");
  assert.equal(series.nextEpisodeNumber, 11);
  assert.equal(Object.keys(series.idempotency).length, 10);
  assert.equal(series.months.length, 1);
  assert.equal(series.months[0].episodeCount, 10);
  const volume = await inspectVolume(library, "fresh-book", "2026-07");
  assert.equal(volume.episodes.length, 10);
  for (let index = 1; index <= 10; index += 1) {
    assert.equal(series.idempotency[`entry-${index}`], `episode-${index}`);
    assert.ok(volume.episodes.some((entry) => entry.episodeId === `episode-${index}`));
    const saved = JSON.parse(await readFile(path.join(library, `books/fresh-book/episodes/episode-${index}.json`), "utf8"));
    assert.equal(saved.episodeId, `episode-${index}`);
  }
  assert.deepEqual(await readdir(path.join(library, "runtime/locks")), []);
});
