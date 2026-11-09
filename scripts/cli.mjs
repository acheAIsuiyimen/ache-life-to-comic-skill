#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import path from "node:path";
import {atomicWriteJson, ensureDir, readJsonIfExists} from "./io.mjs";
import {appendEpisode, inspectSeries, inspectVolume, validateMonth} from "./monthly-serial.mjs";
import {buildContextPack} from "./context-pack.mjs";
import {planLayout, validateLayoutPlan} from "./layout-plan.mjs";
import {
  answerOnboarding,
  loadOnboardingState,
  profileFromOnboarding,
  saveOnboardingState,
  startOnboarding
} from "./onboarding.mjs";
import {planEntry, resolveCompoundInput} from "./plan-entry.mjs";
import {resolvePublicationTarget} from "./publication-target.mjs";
import {validateEntry} from "./validate-entry.mjs";
import {
  normalizeCapabilities,
  resolveVisualMode
} from "./runtime-capabilities.mjs";
import {
  resolvePresentationMode
} from "./presentation.mjs";
import {
  exportPortableShare,
  inspectPortableShares,
  preparePortableSharePrompt
} from "./portable-export.mjs";
import {validateRenderedHtml} from "./validate-rendered-html.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = rest[index + 1]?.startsWith("--") ? true : rest[index + 1];
    args[key] = value;
    if (value !== true) index += 1;
  }
  return {command, args};
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeSegment(value, label) {
  const segment = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)) {
    throw new Error(`${label} must be a safe file segment`);
  }
  return segment;
}

function characterProfile(value = "none") {
  if (value === "none") return {mode: "none", ids: []};
  if (value === "66-dawang") {
    return {mode: "recurring", ids: ["66-dawang"]};
  }
  return {mode: "recurring", ids: [safeSegment(value, "character id")]};
}

async function main() {
  const {command, args} = parseArgs(process.argv.slice(2));

  if (command === "capabilities") {
    const raw = await readJson(args.input);
    const normalized = normalizeCapabilities(raw);
    const visual = resolveVisualMode({
      capabilities: normalized,
      route: args.route ?? "S",
      noImageChoice: args.choice === true ? null : args.choice ?? null,
      acceptLightForDaily: args["accept-light-daily"] === "true"
    });
    print({capabilities: normalized, visual});
    return;
  }

  if (command === "presentation") {
    const raw = await readJson(args.input);
    print(resolvePresentationMode({
      capabilities: raw,
      assetPath: args.asset
    }));
    return;
  }

  if (command === "onboarding-start") {
    const result = startOnboarding();
    if (args.state) await saveOnboardingState(args.state, result.state);
    print(result);
    return;
  }

  if (command === "onboarding-answer") {
    const current = await loadOnboardingState(args.state);
    const result = answerOnboarding(
      current,
      args.answer === true ? null : args.answer ?? null
    );
    await saveOnboardingState(args.state, result.state);
    print(result);
    return;
  }

  if (command === "onboarding-profile") {
    const state = await loadOnboardingState(args.state);
    print(profileFromOnboarding(state, {
      bookId: args["book-id"] ?? "my-comic-life",
      customTitle: args.title === true ? null : args.title ?? null
    }));
    return;
  }

  if (command === "context") {
    print(buildContextPack(await readJson(args.input)));
    return;
  }

  if (command === "layout") {
    const input = await readJson(args.input);
    const layout = planLayout({
      route: input.route ?? "S",
      input,
      previousTemplates: input.previousTemplates ?? []
    });
    print({layout, validation: validateLayoutPlan(layout)});
    return;
  }

  if (command === "target") {
    print(resolvePublicationTarget(await readJson(args.input)));
    return;
  }

  if (command === "plan") {
    const input = await readJson(args.input);
    const profile = args.profile ? await readJson(args.profile) : {};
    print(planEntry(input, profile));
    return;
  }

  if (command === "compound") {
    const input = await readJson(args.input);
    print(resolveCompoundInput(input.units ?? []));
    return;
  }

  if (command === "validate") {
    print(await validateEntry(await readJson(args.input)));
    return;
  }

  if (command === "validate-html") {
    print(await validateRenderedHtml(path.resolve(args.input)));
    return;
  }

  if (command === "init-book") {
    const library = path.resolve(args.library);
    const bookId = safeSegment(args["book-id"], "bookId");
    if (!bookId) throw new Error("--book-id is required");
    const bookRoot = path.join(library, "books", bookId);
    const profilePath = path.join(bookRoot, "publication-profile.json");
    const existing = await readJsonIfExists(profilePath);
    if (existing) {
      print({status: "exists", profilePath, profile: existing});
      return;
    }
    await ensureDir(bookRoot);
    const profile = {
      schemaVersion: "1.1.0",
      onboardingVersion: "ache-onboarding/1.1.0",
      designSystemVersion: "ache-design-system/1.6.0",
      bookId,
      title: args.title ?? "我的漫画人生",
      style: {
        id: args.style ?? "02-snow-pastel",
        lifecycle: args.style && args.style !== "02-snow-pastel"
          ? "optional_candidate"
          : "validated_preset"
      },
      character: characterProfile(args.character),
      publication: {
        primary: args.target ?? "local-html",
        mirrors: []
      },
      visualFallback: null,
      continuity: "weak",
      episodeCover: true,
      budget: "standard"
    };
    await atomicWriteJson(profilePath, profile);
    print({status: "created", profilePath, profile});
    return;
  }

  if (command === "append") {
    const raw = await readJson(args.input);
    const bookId = safeSegment(raw.bookId, "bookId");
    const library = path.resolve(args.library);
    const profilePath = path.join(
      library,
      "books",
      bookId,
      "publication-profile.json"
    );
    const profile = await readJsonIfExists(profilePath, {});
    const plan = raw.plan ?? planEntry(raw, profile);
    print(await appendEpisode(library, {
      ...raw,
      bookId,
      route: plan.route,
      style: raw.style ?? profile.style ?? null,
      palette: raw.palette ?? plan.layout?.theme?.colors ?? profile.palette ?? null,
      paletteSource: raw.paletteSource ?? plan.layout?.theme?.source ?? (raw.palette ? "chapter-theme" : "style-default")
    }));
    return;
  }

  if (command === "inspect") {
    const library = path.resolve(args.library);
    const bookId = safeSegment(args["book-id"], "bookId");
    const month = Object.hasOwn(args, "month") ? validateMonth(args.month) : null;
    const series = await inspectSeries(library, bookId);
    const volume = month
      ? await inspectVolume(library, bookId, month)
      : null;
    print({series, volume});
    return;
  }

  if (command === "share-prompt") {
    const library = path.resolve(args.library);
    print(await preparePortableSharePrompt(library, {
      bookId: safeSegment(args["book-id"], "bookId"),
      unit: args.unit,
      key: args.key
    }));
    return;
  }

  if (command === "share-choice") {
    const library = path.resolve(args.library);
    print(await exportPortableShare(library, {
      bookId: safeSegment(args["book-id"], "bookId"),
      unit: args.unit,
      key: args.key,
      choice: args.choice
    }));
    return;
  }

  if (command === "share-inspect") {
    const library = path.resolve(args.library);
    print(await inspectPortableShares(
      library,
      safeSegment(args["book-id"], "bookId")
    ));
    return;
  }

  throw new Error(
    "Use onboarding-start, onboarding-answer, onboarding-profile, context, layout, capabilities, presentation, target, plan, compound, validate, init-book, append, inspect, share-prompt, share-choice, or share-inspect"
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
