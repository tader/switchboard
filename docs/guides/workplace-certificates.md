---
title: Workplace certificates
order: 90
---

# Workplace certificates

If MCP sign-in reports **Switchboard doesn’t trust this certificate**, your workplace may inspect HTTPS traffic using a company certificate authority. Switchboard uses the operating system’s trusted authorities when fetching OAuth client metadata.

If the error remains, sign in to Switchboard as an administrator and choose **Review certificate** on the error page. Verify the SHA-256 fingerprint with your IT team, confirm the checkbox, then choose **Trust for this host and retry**. Normal account consent follows separately.

Approval trusts the displayed authority only for OAuth client metadata on that exact host and port. It does not change Windows trust or other Switchboard traffic. Normal website certificate renewal under that authority continues working. A genuinely self-signed website certificate is trusted individually and must be reviewed again when replaced.

Manage and remove exceptions under **Admin → Certificates**. Wrong hostnames and expired certificates cannot be approved. If the server does not supply a usable issuing certificate, contact IT. When Switchboard runs remotely, certificate trust is evaluated on its server, not on the computer displaying the page.
