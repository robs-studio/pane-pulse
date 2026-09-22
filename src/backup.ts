// Dated backups of the files pane-pulse edits, and the one guard every write path shares.
//
// The shape is `.claude/scripts/local_snapshot.py`'s, deliberately: a per-file ring under
// `<root>/backups/<slug>-<sha8>/`, a fixed-width UTC stamp so a lexical sort is chronological,
// a `~1` bump so two writes inside one millisecond cannot clobber an undo step, and a prune to
// the newest RING_SIZE. The backups are taken by one installer, `src/installer.ts`, which both
// roads in run rather than fork: `scripts/install-hooks.mjs` (the command line) and
// `src/commands.ts` (the extension's commands); `src/extension.ts` reads only resolveRoot()
// from here. Node strips the types off this file on import, which is what lets a `.mjs` script
// import the same TypeScript the extension bundles.
//
// The rule the callers inherit: A FAILED BACKUP ABORTS THE WRITE. `backup()` throws rather
// than returning a sentinel, so a caller that ignores the failure cannot reach its own write.
// The one non-failure is a file that does not exist yet -- a cold start has nothing to lose --
// and that answers `null`, never an exception.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** `<root>` holds the deployed hook, the event files, the install record and these backups. */
export const ROOT_ENV = 'PANE_PULSE_HOME';
export const ROOT_BASENAME = '.pane-pulse';
export const BACKUPS_DIRNAME = 'backups';

/** The sidecar that makes a ring browsable: which file this ring belongs to. */
export const ORIGIN_FILE = '.origin';

/** How many versions of one file the ring keeps. The oldest fall off the end. */
export const RING_SIZE = 30;

/**
 * The file whose presence in ANY ancestor means the path belongs to a Glitch brain. Checking
 * only the parent would pass `<brain>/.claude/settings.json`, which is the exact path this
 * guard exists to stop: the engine is read-only to a member, and pane-pulse writes a MEMBER's
 * own configuration, never a brain's.
 */
export const BRAIN_MARKER = 'operations-reference.md';

/** A backup name that has already taken its stamp gets `~1`, `~2`; this bounds the search. */
const MAX_COLLISION_BUMPS = 1000;

/** A file with no extension still needs one, or the prune glob has nothing to match. */
const EXTENSIONLESS = '.bin';

/** The readable half of a ring name, capped so a long path cannot make an unopenable folder. */
const SLUG_LIMIT = 48;

const TMP_SUFFIX = '.pane-pulse-tmp';

export type BackupOptions = {
  /** `<root>`; defaults to PANE_PULSE_HOME, else `~/.pane-pulse`. Injected in every test. */
  readonly root?: string;
  /** The clock. Injected so a collision can be forced rather than waited for. */
  readonly now?: () => Date;
};

export type RestoreOptions = BackupOptions & {
  /**
   * Which backup: its whole file name (`20260920T101112.345Z~1.json`), its stamp
   * (`20260920T101112.345Z`), or a prefix of a name that no other backup shares
   * (`20260920T1011`). Absent means the most recent backup.
   */
  readonly stamp?: string;
};

function fail(message: string): never {
  throw new Error(`pane-pulse backup: ${message}`);
}

/**
 * Abort unless `target` sits outside every Glitch brain on this machine.
 *
 * EVERY write path calls this -- the settings edits, the deployed hook, the record and the
 * backups below -- and it walks every ancestor to the filesystem root rather than glancing at
 * the parent. Returns the resolved path so a caller can use it as the checked one.
 */
export function assertNotInBrain(target: string): string {
  const full = resolve(target);
  let cursor = full;
  for (;;) {
    const marker = join(cursor, BRAIN_MARKER);
    if (existsSync(marker)) {
      fail(
        `refusing to write ${full}: ${marker} marks ${cursor} as a Glitch brain, and the ` +
          'engine is read-only to a member. Point PANE_PULSE_HOME somewhere of your own.',
      );
    }
    const parent = dirname(cursor);
    if (parent === cursor) return full;
    cursor = parent;
  }
}

/** `<root>`, from the environment, falling back to the home directory. */
export function resolveRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env[ROOT_ENV];
  if (typeof configured === 'string' && configured !== '') return resolve(configured);
  return join(home, ROOT_BASENAME);
}

function rootOf(options: BackupOptions): string {
  return options.root === undefined ? resolveRoot() : resolve(options.root);
}

function clockOf(options: BackupOptions): () => Date {
  return options.now === undefined ? (): Date => new Date() : options.now;
}

/** `20260920T161540.123Z` -- UTC, fixed width, so a lexical sort is a chronological one. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '');
}

/** The extension a backup carries, so it stays openable as itself. */
function extensionOf(file: string): string {
  return extname(file) || EXTENSIONLESS;
}

/**
 * A ring's directory name: a readable slug of the path plus a short hash OF THE WHOLE PATH, so
 * two files of the same name in different places never share a ring.
 */
export function ringName(file: string): string {
  const full = resolve(file);
  const slug = full.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
  const digest = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 8);
  return `${slug.slice(0, SLUG_LIMIT)}-${digest}`;
}

/** Where this file's backups live. */
export function ringFor(file: string, options: BackupOptions = {}): string {
  return join(rootOf(options), BACKUPS_DIRNAME, ringName(file));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Keep the newest RING_SIZE backups of this file; drop the oldest. `.origin` has no extension. */
function prune(ring: string, extension: string): void {
  const kept = readdirSync(ring)
    .filter((name) => name.endsWith(extension))
    .sort();
  for (const stale of kept.slice(0, Math.max(0, kept.length - RING_SIZE))) {
    rmSync(join(ring, stale), { force: true });
  }
}

/**
 * Copy a file byte-for-byte into its ring BEFORE it is overwritten, and answer the new backup's
 * path -- or `null` when the file does not exist yet.
 *
 * Throws on any copy failure. A caller about to write must treat that as fatal and refuse to
 * write: a write with no backup behind it is exactly the irreversible write this exists to end.
 */
export function backup(file: string, options: BackupOptions = {}): string | null {
  const source = resolve(file);
  if (!isFile(source)) return null;

  const ring = assertNotInBrain(ringFor(source, options));
  mkdirSync(ring, { recursive: true });
  writeFileSync(join(ring, ORIGIN_FILE), `${source}\n`, 'utf8');

  const extension = extensionOf(source);
  const clock = clockOf(options);
  let destination = join(ring, `${stampOf(clock())}${extension}`);
  for (let bump = 1; existsSync(destination); bump += 1) {
    if (bump > MAX_COLLISION_BUMPS) {
      fail(`no free backup name for ${source} in ${ring} after ${MAX_COLLISION_BUMPS} tries`);
    }
    destination = join(ring, `${stampOf(clock())}~${bump}${extension}`);
  }

  copyFileSync(source, destination);
  prune(ring, extension);
  return destination;
}

/** Every backup of a file, NEWEST FIRST. Empty when it has never been backed up. */
export function list(file: string, options: BackupOptions = {}): readonly string[] {
  const ring = ringFor(file, options);
  if (!existsSync(ring)) return Object.freeze([]);
  const extension = extensionOf(file);
  return Object.freeze(
    readdirSync(ring)
      .filter((name) => name.endsWith(extension))
      .sort()
      .reverse()
      .map((name) => join(ring, name)),
  );
}

/** The most recent backup of a file, or `null` if it has never been backed up. */
export function latest(file: string, options: BackupOptions = {}): string | null {
  const backups = list(file, options);
  return backups.length === 0 ? null : backups[0];
}

/**
 * Crash-atomic and byte-exact: a half-written settings file is worse than none. Exported
 * because the installer writes the same two files this module backs up, and one primitive that
 * both roads call is one guard both roads cannot skip.
 */
export function writeFileAtomic(target: string, contents: Buffer | string): string {
  const full = assertNotInBrain(target);
  const temporary = `${full}${TMP_SUFFIX}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(temporary, contents);
  renameSync(temporary, full);
  return full;
}

/**
 * The backup a restore will use: the newest when no stamp is given; otherwise the one whose
 * whole file name is `stamp`, else the one whose stamp is exactly `stamp` (its name without the
 * extension), else the one backup whose name opens with it. A bare stamp is a prefix of its own
 * `~1` sibling, which sorts first, so an exact match must win before any prefix is read; and a
 * prefix two backups share is refused, naming both, rather than settled by picking one.
 */
function pick(
  backups: readonly string[],
  ring: string,
  stamp: string | undefined,
  extension: string,
): string {
  if (stamp === undefined) return backups[0];
  const byName = backups.find((path) => basename(path) === stamp);
  if (byName !== undefined) return byName;
  const byStamp = backups.find((path) => basename(path, extension) === stamp);
  if (byStamp !== undefined) return byStamp;
  const prefixed = backups.filter((path) => basename(path).startsWith(stamp));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length === 0) {
    fail(`no backup at ${JSON.stringify(stamp)} in ${ring} -- list() shows the stamps`);
  }
  const names = prefixed.map((path) => basename(path)).join(', ');
  fail(
    `${JSON.stringify(stamp)} matches ${prefixed.length} backups in ${ring} (${names}); ` +
      'name one by its whole stamp or file name',
  );
}

/**
 * Put a file back to a prior byte-state and answer its path. The CURRENT state is backed up
 * first, so a restore is itself undoable.
 */
export function restore(file: string, options: RestoreOptions = {}): string {
  const target = assertNotInBrain(file);
  const backups = list(target, options);
  if (backups.length === 0) {
    fail(`no backups of ${target} yet -- there is nothing to roll back to`);
  }

  const wanted = pick(backups, ringFor(target, options), options.stamp, extensionOf(target));

  const bytes = readFileSync(wanted);
  backup(target, options);
  writeFileAtomic(target, bytes);
  return target;
}
