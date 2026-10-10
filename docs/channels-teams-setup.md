# Microsoft Teams channels: owner setup

This guide is in ASD-STE100 Simplified Technical English. It tells the owner (or the customer's Microsoft 365 admin) how to connect Marketplace Channels to Microsoft Teams.

Marketplace sends agent messages to Teams through the Bot Framework. You make one Azure Bot for your organization. Then you install a Teams app in each team or chat where agents can post.

## What you need

- An Azure subscription, for the Azure Bot resource.
- A Microsoft Entra (Azure AD) account that can register apps in your tenant.
- A Teams administrator, to allow and upload a custom app.
- The public address of your Marketplace (for example `https://marketplace.example.com`).

## 1. Make the Azure Bot (single-tenant)

1. In the Azure portal, create an **Azure Bot** resource.
2. Set **Type of App** to **Single Tenant**. (Microsoft stopped the creation of new multi-tenant bots on 31 July 2025.)
3. Select **Create new Microsoft App ID**.
4. After the deployment, open the bot resource. Go to **Configuration**.
5. Copy the **Microsoft App ID** and the **App Tenant ID**.
6. Set **Messaging endpoint** to `<Marketplace public address>/api/marketplace/channels/teams/messages`.
   Example: `https://marketplace.example.com/api/marketplace/channels/teams/messages`.
7. Go to **Channels**. Add the **Microsoft Teams** channel. Accept the default settings (commercial cloud).

Caution: Marketplace supports the commercial cloud and GCC only. GCC High, DoD and Teams operated by 21Vianet use a different sign-in service. Marketplace refuses their messages.

## 2. Make a client secret

1. In **Configuration**, select **Manage Password** next to the Microsoft App ID. This opens the Entra app registration.
2. Go to **Certificates & secrets**. Select **New client secret**.
3. Set an expiry date. Write the date in your calendar. Marketplace stops sending when the secret expires.
4. Copy the secret **Value** immediately. Entra shows it only one time.

Warning: The secret gives full control of the bot. Do not put it in chat, email, tickets or code. Put it only in Account Connections (step 4).

## 3. Optional: person lookup for direct messages

Do this step only if agents must start 1:1 chats with named people.

1. In the Entra app registration, go to **API permissions**.
2. Add the **Microsoft Graph** application permission **User.Read.All**.
3. Select **Grant admin consent**.
4. In step 4, set **Microsoft Teams person lookup** to `true`.

Note: A 1:1 chat works only after the Teams app is installed for that person. An admin can install it for users with a Teams app setup policy. Automatic install through Graph is a later step in Marketplace.

## 4. Add the credentials to Marketplace

1. Open Teal Brick Portal. Go to **Account Connections**.
2. Add these values for Marketplace Channels:
   - **Microsoft Teams bot app ID**: the Microsoft App ID.
   - **Microsoft Teams bot client secret**: the secret value.
   - **Microsoft Teams tenant ID**: the App Tenant ID.
   - **Microsoft Teams person lookup**: `true` only if you did step 3.
3. Restart (redeploy) Marketplace. Marketplace reads the values at start.
4. Open Marketplace **Channels**. Make sure that Microsoft Teams shows **Available**.

Self-hosted Marketplace: store the values as connector secrets `appId`, `appSecret` and `tenantId` under `channels-teams`.

If Teams shows **Credential invalid**, make sure that the three values come from the same app registration and the same tenant.

## 5. Make the Teams app package

1. Copy `docs/channels-teams-app-manifest.json` to a new folder. Rename it to `manifest.json`.
2. Replace `<MICROSOFT-APP-ID>` (two places) with the Microsoft App ID.
3. Replace `<NEW-GUID-FOR-THIS-TEAMS-APP>` with a new GUID. Do not use the app ID here.
4. Replace the developer name and the three web addresses with your own.
5. Add two icons to the folder: `color.png` (192 × 192 pixels) and `outline.png` (32 × 32 pixels, white on transparent).
6. Make a ZIP file of the three files. Put them at the top level of the ZIP, not in a folder.

The package asks for these permissions:
- Bot scopes `team`, `groupChat` and `personal`.
- Resource-specific consent (RSC) `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat`. With these, the bot receives all messages in the teams and chats where it is installed, not only messages that mention it. Marketplace does not store received messages yet.

## 6. Allow and upload the app (Teams admin)

1. Open the **Teams admin center**. Go to **Teams apps** > **Manage apps**.
2. Select **Upload new app**. Upload the ZIP file.
3. Make sure that the app status is **Allowed**.
4. Go to **Teams apps** > **Permission policies** (or app-centric management). Make sure that the users who install the app can use custom apps.
5. Make sure that team owners can give RSC consent. The default tenant setting (`ManagedByMicrosoft`) permits this.

## 7. Install the app in each team or chat

1. In Teams, open the team. Select **Apps** > **Built for your org**. Select the app.
2. Select **Add to a team**. Select the team and the channel. The team owner accepts the permissions.
3. For a group chat, select **Add to a chat**.
4. In Marketplace **Channels**, select **Add channel** > **Microsoft Teams** > **Discover**.

Marketplace lists the standard channels of each team where the app is installed, and the group chats and 1:1 chats that have the app.

Note: Marketplace does not list private and shared channels. Teams bots cannot post in private channels.

## What agents can do in Teams

- Post text (Teams Markdown, maximum 28,000 characters).
- Reply in a channel thread.
- Mention named people. Agents never mention a whole team, a channel or a tag.
- Edit and delete their own messages.
- With person lookup: find one person by email and start a 1:1 chat.

Agents cannot send files, images, cards or reactions in Teams in this version.

Approvals stay in Teal Brick, Buzz and the Marketplace screen. Teams shows "waiting for owner approval" and never accepts an approval click.

## Rotate or remove

- To rotate the secret: make a new secret (step 2), update Account Connections, redeploy Marketplace, then delete the old secret in Entra.
- To stop all posts: remove the app from the team in Teams, or remove the credentials and redeploy. Marketplace marks the conversation removed when Teams tells it that the app was uninstalled.
