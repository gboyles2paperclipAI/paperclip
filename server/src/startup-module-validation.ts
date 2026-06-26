const criticalStartupModules = [
  {
    specifier: "@paperclipai/db/client",
    expectedFileName: "client.js",
  },
] as const;

type CriticalStartupModule = (typeof criticalStartupModules)[number];

export type StartupModuleValidationError = Error & {
  exitCode: 2;
  expectedFileName: string;
  missingPath: string;
  specifier: string;
};

type ValidateCriticalStartupModulesOptions = {
  importer?: (specifier: string) => Promise<unknown>;
  resolveModule?: (specifier: string) => string;
};

type RunStartupModuleValidationOptions = ValidateCriticalStartupModulesOptions & {
  exit?: (code: number) => never;
  writeError?: (line: string) => void;
};

function modulePathFromError(error: unknown, expectedFileName: string): string | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/'([^']+)'/);
  if (match?.[1]?.includes(expectedFileName)) return match[1];
  return null;
}

function fileUrlToPath(value: string): string {
  return value.startsWith("file://") ? new URL(value).pathname : value;
}

function resolveExpectedPath(
  startupModule: CriticalStartupModule,
  resolveModule: (specifier: string) => string,
): string {
  try {
    return fileUrlToPath(resolveModule(startupModule.specifier));
  } catch {
    return startupModule.expectedFileName;
  }
}

function toStartupModuleValidationError(
  startupModule: CriticalStartupModule,
  error: unknown,
  resolveModule: (specifier: string) => string,
): StartupModuleValidationError {
  const missingPath =
    modulePathFromError(error, startupModule.expectedFileName) ??
    resolveExpectedPath(startupModule, resolveModule);
  const validationError = new Error(
    `Missing startup module ${startupModule.specifier}: ${missingPath}`,
  ) as StartupModuleValidationError;
  validationError.exitCode = 2;
  validationError.expectedFileName = startupModule.expectedFileName;
  validationError.missingPath = missingPath;
  validationError.specifier = startupModule.specifier;
  validationError.cause = error;
  return validationError;
}

export async function validateCriticalStartupModules(
  options: ValidateCriticalStartupModulesOptions = {},
): Promise<void> {
  const importer = options.importer ?? ((specifier: string) => import(specifier));
  const resolveModule = options.resolveModule ?? import.meta.resolve;

  for (const startupModule of criticalStartupModules) {
    try {
      await importer(startupModule.specifier);
    } catch (error) {
      throw toStartupModuleValidationError(startupModule, error, resolveModule);
    }
  }
}

export async function runStartupModuleValidationOrExit(
  options: RunStartupModuleValidationOptions = {},
): Promise<void> {
  const exit = options.exit ?? process.exit;
  const writeError = options.writeError ?? ((line: string) => console.error(line));

  try {
    await validateCriticalStartupModules(options);
  } catch (error) {
    if (isStartupModuleValidationError(error)) {
      writeError(`[paperclip] missing module: ${error.expectedFileName}`);
      writeError(`[paperclip] missing module path: ${error.missingPath}`);
      writeError(
        `[paperclip] startup module validation failed for ${error.specifier}; exiting with status ${error.exitCode}`,
      );
      exit(error.exitCode);
    }
    throw error;
  }
}

function isStartupModuleValidationError(error: unknown): error is StartupModuleValidationError {
  return (
    error instanceof Error &&
    (error as Partial<StartupModuleValidationError>).exitCode === 2 &&
    typeof (error as Partial<StartupModuleValidationError>).expectedFileName === "string" &&
    typeof (error as Partial<StartupModuleValidationError>).missingPath === "string" &&
    typeof (error as Partial<StartupModuleValidationError>).specifier === "string"
  );
}
