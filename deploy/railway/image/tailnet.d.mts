import type { ChildProcess, spawn } from "node:child_process";

export declare const TAILNET_PROXY_LISTEN: string;
export declare const TAILNET_PROXY_URL: string;
export declare const DEFAULT_TS_HOSTNAME: string;
export declare const TAILNET_UP_TIMEOUT_MS: number;

type Env = Record<string, string | undefined>;
export type TailnetOutcome =
  | { state: "connected"; stop: () => void; daemon: ChildProcess }
  | { state: "unavailable"; reason: string };

export declare function tailnetRequested(env: Env): boolean;
export declare function withoutAuthKey(env: Env): Env;
export declare function appEnvironment(env: Env, outcome: { state: string }): Env;
export declare function tailnetHostname(env: Env): string;
export declare function startTailnet(options: {
  env: Env;
  log?: (message: string) => void;
  spawn?: typeof spawn;
  binDir?: string;
  tmpDir?: string;
  timeoutMs?: number;
}): Promise<TailnetOutcome>;
export declare function launchMarketplace<T>(options: {
  env: Env;
  importApp: () => Promise<unknown>;
  spawnApp: (env: Env) => T;
  startTailnet?: (options: { env: Env; log?: (message: string) => void }) => Promise<TailnetOutcome>;
  log?: (message: string) => void;
}): Promise<{ mode: "direct" } | { mode: "supervised"; outcome: TailnetOutcome; child: T }>;
