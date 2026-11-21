# Account email delivery

Account creation sends verification and temporary-password emails separately.
POST /api/v1/accounts returns 201 once the account exists; emailStatus is accepted,
local or failed. Accepted means provider acceptance, not inbox delivery. Clients
must show recovery instructions for failed and must not repeat account creation.

Existing affected users: use Forgot password on the sign-in screen, set a new
password through that email, and verify the address if requested. Do not delete
and recreate the account. If reset email fails too, inspect Resend Logs and the
Vercel log event "Email provider rejected a send" for code/status.

Check RESEND_API_KEY, verified sender domain and EMAIL_FROM on Vercel. Do not paste
credentials or email bodies into logs. Quota, restricted-key and validation errors
need configuration/provider action; retries do not repair them. The implementation
retries temporary rate limits/server errors at most three times using the same
HTTP idempotency key, with a bounded Retry-After delay. No new env vars required.

Testing uses a mocked provider and isolated MongoDB; no real account mail is sent.
The screenshot alone does not identify the provider's exact rejection reason.

Local configuration inspection on 21 November found gmail.com as the sender
domain. This is not a verified domain controlled by this project. The configured
sending-only key returned restricted_api_key for the read-only domains endpoint;
that is expected for this key scope and does not mean it cannot send. Vercel
environment values have not been inspected. Set EMAIL_FROM to an address on your
verified domain and redeploy the API after changing Vercel environment variables.
