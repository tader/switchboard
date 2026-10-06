---
title: Setting up Microsoft sign-in
order: 0
dependents: true
---

# Setting up Microsoft sign-in

Outlook Mail, Outlook Calendar, OneDrive, Microsoft To Do and *Microsoft Graph* connections sign in through an **app registration** in Microsoft Entra ID. It works for Microsoft 365 work or school accounts and for personal accounts (Outlook.com, Hotmail, Live). An administrator sets it up once for everyone under **Plugins → Microsoft → Settings**. Users can also bring their own registration in the connect dialog, under *Advanced*.

You need a Microsoft account that can create app registrations. Any personal account can, through the free Entra admin center. In an organization, your administrator may have to create it, or approve it afterwards.

## 1. Register the app

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com), go to **App registrations** (under *Entra ID*, or *Identity → Applications* in older versions of the admin center) and choose **New registration**.
2. Name it, for example *Switchboard*.
3. Under **Supported account types**, choose who may sign in:
   - **Accounts in any organizational directory and personal Microsoft accounts** for both work and personal accounts. In Switchboard, set *Accounts* to *Work, school and personal*.
   - **Accounts in this organizational directory only** for one organization. In Switchboard, enter the tenant ID as each connection's *Tenant*, under *Advanced*.
   - **Personal Microsoft accounts only**. In Switchboard, set *Accounts* to *Personal*.
4. Under **Redirect URI**, choose **Web** and enter:

   ```text
   {{callbackUrl}}
   ```

5. Choose **Register**. Copy the **Application (client) ID** from the overview page.

## 2. Add permissions

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add what the services need:

| Service | Permissions |
|---|---|
| Always | `offline_access`, `openid`, `profile`, `email`, `User.Read` |
| Outlook Mail | `Mail.Read`, or `Mail.ReadWrite` and `Mail.Send` |
| Outlook Calendar | `Calendars.Read` or `Calendars.ReadWrite` |
| OneDrive | `Files.Read`, `Files.ReadWrite` or `Files.ReadWrite.All` |
| Microsoft To Do | `Tasks.Read` or `Tasks.ReadWrite` |
| Microsoft Graph | whatever you enter as its permissions |

Microsoft asks each user to approve the permissions when they connect. Strictly, Microsoft accepts delegated permissions that are not listed here too, but listing them makes the consent screen and admin approval predictable.

> [!NOTE]
> In many organizations, users may not approve apps themselves and see *"Need admin approval"*. An administrator can choose **Grant admin consent for …** on the API permissions page, once for everyone.

## 3. Choose how users sign in

Switchboard offers two ways to sign in. Set up one or both.

**Sign in with Microsoft** (through the browser) needs a client secret:

1. Go to **Certificates & secrets → Client secrets → New client secret**.
2. Choose an expiry and **Add**, then copy the secret's **Value**. It is shown only once.

> [!IMPORTANT]
> Client secrets expire, after 24 months at most. Put a reminder in your calendar: once it expires, browser sign-in and token refreshes fail until you add a new secret in Switchboard.

**Sign in with a code** (at microsoft.com/devicelogin) needs no secret:

1. Go to **Authentication** (or **Authentication → Settings**).
2. Turn on **Allow public client flows** and save.

This is the simplest option for personal use, and it also works when browser redirects are not possible.

## 4. Enter it in Switchboard

Under **Plugins → Microsoft → Settings**, enter the Application (client) ID and, for browser sign-in, the client secret. Choose which accounts may sign in, matching step 1, and save. Users can now connect their Microsoft accounts.

## Troubleshooting

| Error | Cause |
|---|---|
| `AADSTS50011` … *redirect URI … does not match* | The redirect URI in step 1 must be exactly `{{callbackUrl}}`, of type **Web**. |
| `AADSTS700016` *application … was not found*, or `AADSTS700038` *not a valid application identifier* | The client ID is wrong, or the account type does not match the registration's supported account types (step 1). |
| `AADSTS7000215` *Invalid client secret* | Copy the secret's **Value**, not its ID. Or the secret expired: add a new one (step 3). |
| `AADSTS7000218` … *client_assertion or client_secret* | Sign in with a code needs **Allow public client flows** turned on (step 3). |
| *Need admin approval* | Ask an administrator to grant consent (step 2). |
| `AADSTS50020` … *does not exist in tenant* | A personal account is signing in to an app that allows only one organization, or the other way around. Check *Accounts* in Switchboard's settings. |
| Calls fail with `403` | The connection lacks a permission. Reconnect with a higher *Access* level, and check the permission is added in step 2. |
