// Whether Node.js can be found: the one fact the first-run prompt and Install Hooks' closing
// message check before they speak.
//
// Most of the hooks Pane Pulse installs start `node` by name (installer.ts nodeCommand(), the
// exec form, so no shell is involved), and Claude Code's native installer does not bring Node. So
// a Mac set up that way can have every hook in place and still see almost no marks, with nothing
// saying why. findNode() asks the operating system for `node --version` the way Claude Code will
// start those hooks, and its answer picks the prompt's words and decides whether Install Hooks'
// closing message gains NODE_MISSING_SENTENCE. Four rules:
//
//   * THE EXTENSION HOST'S PATH IS THE QUESTION. `node` is run by name with no shell, on this
//     process's own environment, so it is looked up the way the hooks' own `node` will be. On
//     macOS VS Code resolves that PATH from the login shell, the same PATH a VS Code terminal,
//     and so Claude Code, gets. On Windows libuv resolves `node` to `node.exe`.
//   * COULDN'T FIND, NEVER NOT INSTALLED. A Node this process cannot see (nvm set up only in an
//     interactive rc file, say) reads as missing, so every word says Pane Pulse couldn't find
//     it, never that it is not installed. The answer only picks words: nothing here blocks
//     Set it up, and nothing here writes anything.
//   * ONLY A VERSION IS AN ANSWER. true only when stdout starts `v<digits>.`, as `node --version`
//     prints it. A command not found, a run that fails or is killed, and anything else on stdout
//     all read as not found.
//   * NEVER THROWS, NEVER HANGS. The run gets NODE_CHECK_TIMEOUT_MS, after which execFile kills
//     it, and findNode() stops waiting a moment later even if the run never settles (a child that
//     ignores the kill). A run that throws, even before it hands back a promise, reads as not
//     found. The callers start it in the background, so no one waits on it.
//
// No vscode import: the run is handed in, so node --test drives every answer with no VS Code and
// no real `node` on the PATH.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Runs `file` with `args` and resolves its stdout; rejects on any failure, a command not found,
 * a non-zero exit or a run killed at `timeoutMs` among them.
 */
export type NodeRun = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

/** How long `node --version` may take before it is killed and read as not found. */
export const NODE_CHECK_TIMEOUT_MS = 3000;

/** Where Get Node.js goes. */
export const NODE_SITE = 'https://nodejs.org';

/** Install Hooks' closing message gains this, and only this, when Node could not be found. */
export const NODE_MISSING_SENTENCE =
  "One more step: Claude Code runs these hooks with Node.js, and Pane Pulse couldn't find it. " +
  'Install it from nodejs.org, then restart VS Code, and the marks will start.';

/** The name the hooks start (installer.ts nodeCommand()), looked up on PATH. */
const NODE_COMMAND = 'node';

/** Prints the version and exits, touching nothing. */
const VERSION_ARGS: readonly string[] = Object.freeze(['--version']);

/** What `node --version` prints first: `v22.18.0`. */
const NODE_VERSION = /^v\d+\./;

/** How long past the timeout findNode() still waits for a run that was told to stop. */
const BACKSTOP_GRACE_MS = 500;

const execFileAsync = promisify(execFile);

/** The real run: `file` looked up on this process's PATH, with no shell and no console window. */
async function defaultRun(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
  });
  return stdout;
}

/** The run started, with a synchronous throw turned into a rejection. */
function started(run: NodeRun): Promise<string> {
  try {
    return Promise.resolve(run(NODE_COMMAND, VERSION_ARGS, NODE_CHECK_TIMEOUT_MS));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Whether `node --version` answers with a version. Never throws and never rejects: every
 * failure, a hang included, resolves false.
 */
export async function findNode(run: NodeRun = defaultRun): Promise<boolean> {
  let backstop: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    // Kept referenced, so it answers even when nothing else holds the process open; the
    // finally below clears it the moment the run settles first.
    backstop = setTimeout(() => resolve(undefined), NODE_CHECK_TIMEOUT_MS + BACKSTOP_GRACE_MS);
  });
  try {
    const stdout = await Promise.race([started(run), gaveUp]);
    return typeof stdout === 'string' && NODE_VERSION.test(stdout);
  } catch {
    return false;
  } finally {
    clearTimeout(backstop);
  }
}

/** `message` as it is, or with NODE_MISSING_SENTENCE after it when Node could not be found. */
export function withNodeNote(message: string, nodeFound: boolean): string {
  return nodeFound ? message : `${message} ${NODE_MISSING_SENTENCE}`;
}
