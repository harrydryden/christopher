# LinkedIn sign-in setup

This release adds an optional sign-in method to the existing Course of Life account. It does not import a complete LinkedIn profile through the sign-in API. Career evidence still comes from the user's own PDF, CV or pasted text and follows the existing Experience review.

## Configure the provider

1. Create the organisation's application in the [LinkedIn developer portal](https://www.linkedin.com/developers/apps). Complete Company Page association/verification as requested by LinkedIn.
2. Request **Sign In with LinkedIn using OpenID Connect**. Check that the application has `openid`, `profile` and `email` available. Other LinkedIn products are not required for this release.
3. Register the exact HTTPS callback URL: `<APP_URL>/auth/linkedin/callback`. Use a separate stable test deployment/callback for hosted testing. Do not use wildcard redirect URLs.
4. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in the web deployment's server-side environment. Set `APP_URL` to its canonical public origin and retain the existing strong `SESSION_SECRET`. Never use `NEXT_PUBLIC_` for credentials or paste secrets into an issue or chat.
5. Apply the checked-in database migration before enabling the web release. Ensure the ordinary confirmation/password-reset email service works; some LinkedIn members will not supply a verified email claim.
6. Complete the hosted acceptance checks below before enabling sign-in for customers. A successful local test with a simulated provider does not prove LinkedIn product approval or production credentials.

## How accounts interact

- A first-time LinkedIn identity shows the supplied email before creating an account, with a choice to use an existing account instead. This avoids silently creating a second account when LinkedIn uses a different address.
- A previously linked LinkedIn identity returns to the same account. Email/password and Google remain available according to that account's existing methods.
- LinkedIn can return email and its verification status, but [both fields are optional](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2). Never assume that requesting the email scope guarantees them.
- A matching email suggests an existing account; it is not permission to attach a new sign-in method. The user proves access to the existing account and explicitly confirms linking. [Account-linking guidance](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts) recommends authentication of both identities.
- Existing users whose LinkedIn email differs should start from Account settings and link to their current account. Do not create a second account and try to merge CVs or credits afterwards.
- Email uniqueness prevents two accounts using the same normalised address. No identity provider can establish that two unrelated email addresses belong to the same human; names and profile photos must never be used to merge accounts.
- Linking does not replace the account's primary email, change ownership of documents, grant extra welcome credits or import career information. An unverified existing account must confirm its email before linking.

## Hosted acceptance checklist

Use dedicated test accounts and never use production customer records as test fixtures.

1. New member with a verified LinkedIn email: confirm the displayed address and create the account, confirm a single account exists, and reach the normal Experience onboarding.
2. Existing email/password member: start with LinkedIn, authenticate the original account, explicitly link, then sign out and sign in through both methods. Confirm the same account ID, CVs and credit balance.
3. Existing Google member: repeat linking through Google, including a LinkedIn profile with a different email when initiated from Account settings.
4. Missing/unverified LinkedIn email: complete the fallback verification flow. Confirm no placeholder or duplicate account is created and no paid processing happens before email proof.
5. Cancel consent, expire a continuation, replay a callback and try to link an identity already owned by another account. Each must fail safely without changing ownership.
6. Confirm the account cannot remove its last usable sign-in method. Disconnecting LinkedIn must not delete Experience or saved CVs. This removes the local sign-in method; revoke the application separately in LinkedIn to remove its provider-side consent.
7. Follow the LinkedIn PDF instructions, upload the user's own profile, review proposals and confirm evidence. Merely signing in must not claim that a profile was imported.
8. Check closed registration, administrator entitlement, email delivery, secret-free logs and the behaviour when LinkedIn configuration is absent.

## Scope and later work

Connections CSV import, automatic career import through approved Member Data Portability, `/identityMe` Plus, employer/ATS integrations and LinkedIn job-search capabilities are not enabled by this release. See [ADR 0006](adr/0006-linkedin-identity-import-and-network.md) for access boundaries and later phases.
