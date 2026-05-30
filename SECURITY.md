# Security Policy

Sens is a **local-first** application: your financial data is stored only in a local SQLite file on your own machine. There is no server, no account, no cloud sync, and no network transmission of your data. This significantly limits the attack surface — but we still take security seriously, especially since Sens handles personal financial information.

## Supported versions

Security fixes are applied to the **latest released version**. Please make sure you're on the most recent release before reporting.

| Version | Supported |
| ------- | --------- |
| Latest release (`1.x`) | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report them privately using **[GitHub Private Security Advisories](https://github.com/Jmyz72/Sens/security/advisories/new)**:

1. Go to the **Security** tab of the repository.
2. Click **Report a vulnerability**.
3. Provide a clear description, including:
   - The affected version(s) and platform (macOS / Windows / Linux)
   - Steps to reproduce, or a proof of concept
   - The potential impact as you see it
   - Any suggested remediation, if you have one

You'll receive a response acknowledging the report. We'll work with you to understand and validate the issue, and keep you updated on the fix and disclosure timeline.

## Disclosure

We follow **coordinated disclosure**. Please give us a reasonable window to investigate and ship a fix before any public disclosure. We're happy to credit reporters in the release notes unless you'd prefer to remain anonymous.

## Scope notes

Because Sens has no backend or network features, the most relevant classes of issue are:

- Local data integrity or corruption bugs (e.g. money/balance miscalculation)
- Vulnerabilities in the auto-updater or release/signing pipeline
- Supply-chain issues in bundled dependencies (npm / Cargo)
- Tauri command surface issues (improper validation between frontend and backend)

Thank you for helping keep Sens and its users safe.
