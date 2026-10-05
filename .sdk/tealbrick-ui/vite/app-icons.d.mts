import type { Plugin } from "vite";

export interface TealbrickAppIconsOptions {
  /** Full app name for the web manifest, e.g. "Teal Brick Marketplace". */
  readonly name: string;
  /** Home-screen label; defaults to `name`. */
  readonly shortName?: string;
  readonly themeColor?: string;
  readonly darkThemeColor?: string;
  readonly backgroundColor?: string;
}

export function tealbrickAppIcons(options: TealbrickAppIconsOptions): Plugin;
