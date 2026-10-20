// The text of the file "Save the recovery code to a file" and of the printed sheet (О3). It holds
// the code and an honest warning, and nothing else secret: never the password.

import type { TFunction } from "i18next"

export interface RecoveryFileContext {
  /** The host of the server, e.g. `sync.example.com`. */
  host: string
  /** The user name on the server. */
  username: string
  /** The code as shown: 14 groups joined by `-`. */
  recoveryCode: string
}

/** The whole text of the file. */
export function recoveryFileText(context: RecoveryFileContext, t: TFunction): string {
  void context
  void t
  throw new Error("not implemented")
}
