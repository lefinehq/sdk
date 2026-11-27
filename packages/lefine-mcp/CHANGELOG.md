# @lefine/mcp

## 0.3.0

### Minor Changes

- `npx @lefine/mcp` is the friendly front door. Run it in a terminal with no arguments and it opens the setup wizard (the same code as `npx lefine setup`, no copy). `npx @lefine/mcp setup`, `--list`, `--remove`, `--doctor`, `--print`, `--yes`, `--readonly` mirror `lefine setup`. When an AI app starts it (stdin is not a terminal) it is the stdio server, exactly as before, so configs that say `npx -y @lefine/mcp` keep working. README starts with `npx @lefine/mcp`.
- Updated dependencies
  - lefine@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - lefine@0.8.0

## 0.2.6

### Patch Changes

- Updated dependencies
  - lefine@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies
  - lefine@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - lefine@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies
- Updated dependencies
  - lefine@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - lefine@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - lefine@0.2.0

## 0.2.0

### Minor Changes

- `@lefine/mcp` is now a thin alias of `npx lefine mcp`: it depends on `lefine` and runs its `mcp` command, so configs that say `npx -y @lefine/mcp` keep working. Publish `lefine` first.

### Patch Changes

- Updated dependencies
  - lefine@0.1.0
