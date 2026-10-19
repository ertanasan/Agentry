// What differs between the systems a runner can run on. macOS today; the Windows implementation (winhost) comes
// with the Windows runner (winhost review T7), alongside its sandbox and process-tree handling.
export type Platform = {
  // The argv that runs one recipe command line in this system's shell.
  shell(command: string): string[];
};

export const platform: Platform = {
  shell: (command) => ["/bin/zsh", "-c", command],
};
