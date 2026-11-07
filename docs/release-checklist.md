# Release checklist

## Source review

- Export only the approved source files into a fresh public Git repository. Do not push this development repository's older commits or tags: its history contains private design previews and real book covers.
- Keep `design-preview/`, personal handoff documents, machine-specific recovery scripts, databases, EPUB/TXT books, caches, `out/`, and `release/` out of the public repository.
- Check public files for credentials, personal absolute paths, and copyrighted book content before the first push.
- Use the MIT license for the public source and original butterfly icon.

## Windows package

- Run `pnpm install --frozen-lockfile`, `pnpm verify`, and `pnpm package:win` on Windows x64.
- Run `pnpm test:e2e:release` against `release/distribution/win-unpacked/Aetherbound.exe`. All automated tests must set an isolated `READER_DATA_ROOT`; never run them against the normal user profile.
- Check that `release/distribution/` contains the offline NSIS installer, ZIP, and SHA-256 checksums. Keep these binaries out of Git history.
- Test install, launch, upgrade, uninstall, and reinstall on a clean Windows account or VM. Confirm that uninstall retains the test profile and that imported original files remain untouched.
- Test an existing profile through the standard `%APPDATA%\Aetherbound` path, including a profile whose path is a junction to another drive. The app must not search hard-coded drive letters.

## Publication

- Create a version tag matching `package.json` (for example, `v0.5.0-beta.1`). The release workflow builds and attaches assets to a draft GitHub Release.
- Review the draft's installer, checksum, changelog, and unsigned-app warning before making the release visible.
- Keep the NSIS application ID stable after the first installer release; changing it later changes upgrade identity.
