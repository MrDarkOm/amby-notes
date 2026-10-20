# Contributing to Amby

Thank you for wanting to help. Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas**: open an issue first and describe what happened or what you
  want, with steps to reproduce for a bug. Never attach your own notes or vault
  files; make a small example instead.
- **Larger changes**: discuss them in an issue before writing code, so the work
  fits the direction of the project.

## Pull requests

- Work from the `dev` branch and open the pull request against `dev`.
- Keep a pull request about one thing. Describe what changes for the person using
  Amby and how you checked it.
- Run the checks before sending: `npm run verify` and `npm run build`. Changes to
  the Rust side also need `npm run rust:test`.
- User-visible text goes into `src/locales/resources.ts` in every language.
- Amby keeps people's Markdown as they wrote it: do not change how notes, their
  front matter or attachments are written without discussing it first.

## License and the Contributor License Agreement

Amby is free software under the [GNU AGPL-3.0](LICENSE), with an
[additional permission for plugins](LICENSE-PLUGIN-EXCEPTION.md).

Before your first pull request can be merged, you sign the
[Contributor License Agreement](CLA.md) once: the CLA bot asks you in the pull
request, and you sign by posting the sentence it gives. You keep the copyright in
your work. The agreement lets the maintainer also distribute it under other terms,
for example to publish Amby in the App Store, whose terms do not fit the AGPL, or
to offer a commercial license. In return, everything included in a release stays
available to everyone under the AGPL or another open-source license.

## Security

Do not report a vulnerability in a public issue. Use
[GitHub's private vulnerability reporting](https://github.com/MrDarkOm/amby-notes/security/advisories/new)
instead.
