/**
 * Shared types for the CLI analyzer
 */

export interface Issue {
  file: string;
  line: number;
  column: number;
  text: string;
  type:
    | "jsx-text"
    | "jsx-attribute"
    | "ternary-locale"
    | "string-variable"
    | "toast-message";
  severity: "error" | "warning" | "info";
  message: string;
  suggestedKey?: string;
  key?: string; // Extracted translation key
  bindingType?: NamespaceBindingType;
  namespace?: string;
  isDynamic?: boolean; // True if this is a dynamic key (template literal or computed)
  pattern?: string; // For dynamic keys: the pattern like 'plans.${x}.name'
}

export type NamespaceBindingType =
  | "bound-scoped"
  | "root-scoped"
  | "unknown-scoped"
  | "unbound";

export interface NamespaceBinding {
  type: NamespaceBindingType;
  namespace?: string; // For bound-scoped
  dynamic?: boolean; // For unknown-scoped
}

export interface ScanStats {
  dynamicKeys: number;
  dynamicNamespaces: number;
  unboundTranslators: number;
  rootScopedTranslators: number;
  dataStructureKeys?: number;
  dataStructureScopes?: number;
}

/**
 * Represents a dynamic key access pattern detected in code
 */
export interface DynamicPattern {
  pattern: string; // e.g., 'plans.${x}.name'
  file: string;
  line: number;
  namespace?: string;
  bindingType?: NamespaceBindingType;
}

export interface RuleContext {
  filePath: string;
  sourceFile: import("typescript").SourceFile;
  namespaceMap?: Record<string, NamespaceBinding>; // Mapping identifier (e.g., 't') to its scope info
  stats?: ScanStats;
  verbose?: boolean; // Enable detailed logging
  translationScope?: boolean; // True if currently in a translation-aware function
  fileNamespaces?: string[]; // All namespaces detected in file (for fallback inference)
}

export interface ScanOptions {
  dir?: string;
  format: "eslint" | "json";
  maxIssues?: number;
  fix?: boolean;
  ci?: boolean;
  staged?: boolean;
  verbose?: boolean;
}

export interface PullConfig {
  /** Output directory for downloaded translations @default "./locales" */
  output?: string;
  /** Specific locale codes to download (default: all from manifest) */
  locales?: string[];
}

export interface ProjectContext {
  workspaceId: string;
  projectSlug: string;
  defaultLocale: string;
  cdnBaseUrl?: string;
  lint?: LintConfig;
  pull?: PullConfig;
}

export interface DataStructureConfig {
  enabled?: boolean;
  requireTranslationScope?: boolean; // Only detect in functions with 't' parameter
  maxDepth?: number; // Maximum nesting depth to analyze
  propertyNames?: string[]; // Property names that likely contain translation keys
}

export interface LintConfig {
  include?: string[];
  exclude?: string[];
  minLength?: number;
  rules?: Record<string, "error" | "warning" | "off">;
  ignorePatterns?: RegExp[];
  translationFunctions?: string[];
  ignoreStrings?: string[];
  dataStructureDetection?: DataStructureConfig;
}

export interface ScanResult {
  project?: ProjectContext;
  files: number;
  issues: Issue[];
  duration: number;
  localKeys?: Record<string, string[]>;
  dynamicPatterns?: DynamicPattern[]; // Dynamic key access patterns detected in code
  comparison?: {
    localKeys: Record<string, string[]>;
    remoteKeys: Record<string, string[]>;
    missingKeys: Record<string, string[]>;
    unusedKeys: Record<string, string[]>;
    coverage: {
      local: number;
      remote: number;
    };
  };
}

/**
 * CDN Manifest structure from Better i18n
 */
export interface CdnManifest {
  projectSlug: string;
  sourceLanguage: string;
  languages: CdnLanguage[];
  files: Record<
    string,
    {
      url: string;
      size: number;
      lastModified: string;
      /** Schema 2: immutable snapshot version of this file. */
      version?: string;
      /** Schema 2: hex SHA-256 of the exact bytes at the snapshot URL. */
      sha256?: string;
      /** Schema 2: number of texts in the file. */
      keyCount?: number;
      /** Schema 2: app revision at which this file's bytes last changed. */
      revision?: number;
    }
  >;
  updatedAt: string;
  /** `2` on every Lefine manifest; absent on a Better i18n one. */
  schema?: number;
  /** Schema 2: +1 per publish, never reused. */
  revision?: number;
  /** Schema 2: URL of `v/{version}/changes.json`. */
  changesUrl?: string;
  previousVersion?: string | null;
}

/** `v/{version}/changes.json`: what one release changed against the one before it. */
export interface CdnChangesFile {
  revision: number;
  version: string;
  previousVersion: string | null;
  publishedAt: string;
  locales: Record<
    string,
    {
      added: number;
      changed: number;
      removed: number;
      keys: {
        added: Array<[string, string]>;
        changed: Array<[string, string]>;
        removed: Array<[string, string]>;
      };
      truncated: boolean;
    }
  >;
}

export interface CdnLanguage {
  code: string;
  name: string;
  nativeName: string;
  isSource: boolean;
  lastUpdated: string;
  keyCount: number;
  flagUrl: string;
  countryCode: string;
}
