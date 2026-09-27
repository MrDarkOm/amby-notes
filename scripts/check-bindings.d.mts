export function checkGeneratedBindings(options: {
  targetPath: string
  generate: () => Promise<Buffer>
}): Promise<void>
