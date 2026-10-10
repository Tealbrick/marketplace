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

## 3. Person lookup (optional)

Do this step only if agents must find people by email and start 1:1 chats with them. Otherwise, skip it and keep **Microsoft Teams person lookup** off (step 4).

1. In the Entra app registration, open **API permissions**.
2. Add the Microsoft Graph **application** permission **User.Read.All**.
3. Grant admin consent for your tenant.
4. Turn on **Microsoft Teams person lookup** in the Marketplace settings (step 4).

The first message from an agent to a new person always waits for your approval. The app must be installed for that person before the agent can write to them.

## 4. Add the credentials to Marketplace

1. Open Teal Brick Portal. Go to **Account Connections**.
2. Add the secret: **Microsoft Teams bot client secret** = the secret value.
3. Open the Marketplace settings in Portal (double-click Marketplace on the canvas). Set these values. They are not secrets, so you can read them back later:
   - **Microsoft Teams bot app ID**: the Microsoft App ID.
   - **Microsoft Teams tenant ID**: the App Tenant ID.
   - **Microsoft Teams person lookup**: keep it off unless you need 1:1 chats with named people.
4. Restart (redeploy) Marketplace. Marketplace reads the values at start.
5. Open Marketplace **Channels**. Make sure that Microsoft Teams shows **Available**.

Self-hosted Marketplace: store the values as connector secrets `appId`, `appSecret` and `tenantId` under `channels-teams`.

If Teams shows **Credential invalid**, make sure that the three values come from the same app registration and the same tenant.

## 5. Make the Teams app package

1. Copy `docs/channels-teams-app-manifest.json` to a new folder. Rename it to `manifest.json`.
2. Replace `<MICROSOFT-APP-ID>` (two places) with the Microsoft App ID.
3. Replace `<NEW-GUID-FOR-THIS-TEAMS-APP>` with a new GUID. Do not use the app ID here.
4. Replace the developer name and the three web addresses with your own.
5. Add two icons to the folder: `color.png` (192 × 192 pixels) and `outline.png` (32 × 32 pixels, white on transparent).
6. Make a ZIP file of the three files. Put them at the top level of the ZIP, not in a folder.

The package asks for these permissions only:
- Bot scopes `team`, `groupChat` and `personal`.

The package does not ask for resource-specific consent (RSC). Without RSC, Teams sends the bot only the messages that mention it and the messages in 1:1 chats with it. Marketplace passes these messages to an agent only for channels where you turned on inbound routing; otherwise it records install events only.

### Inbound package (optional)

`docs/channels-teams-app-manifest.inbound.json` is a second package template. It adds the RSC permissions `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat`. With these, Teams sends every message in each team and chat where the app is installed to Marketplace.

Caution: Use the inbound package only if agents must receive every message in a channel, not only the messages that mention the bot. Teams then sends all messages of each team and chat where the app is installed to Marketplace. Marketplace keeps only the messages of channels where you turned on inbound routing and drops the rest. Install it only in the teams that need it.

## 6. Allow and upload the app (Teams admin)

1. Open the **Teams admin center**. Go to **Teams apps** > **Manage apps**.
2. Select **Upload new app**. Upload the ZIP file.
3. Make sure that the app status is **Allowed**.
4. Go to **Teams apps** > **Permission policies** (or app-centric management). Make sure that the users who install the app can use custom apps.
5. Only for the inbound package (later): make sure that team owners can give RSC consent. The default tenant setting (`ManagedByMicrosoft`) permits this.

## 7. Install the app in each team or chat

1. In Teams, open the team. Select **Apps** > **Built for your org**. Select the app.
2. Select **Add to a team**. Select the team and the channel.
3. For a group chat, select **Add to a chat**.
4. In Marketplace **Channels**, select **Add channel** > **Microsoft Teams** > **Discover**.

Marketplace lists the standard channels of each team where the app is installed, and the group chats and 1:1 chats that have the app. Each entry shows its type. A channel shows its team name, for example `Ops / #announcements`. A group chat starts with `Group chat:`. A 1:1 chat starts with `Direct chat:`. Marketplace lists at most 1,000 entries of each type.

Note: Marketplace does not list private and shared channels. Teams bots cannot post in private channels.

## What agents can do in Teams

- Post text (Teams Markdown, maximum 28,000 characters) to a channel, a group chat or a 1:1 chat that the owner added.
- Schedule a post. Marketplace sends it at the set time.
- Reply in the thread of a message that Marketplace received (when inbound is on).
- Mention named people. The text must contain `<at>name</at>` for each person.
- Edit or delete a message that Marketplace posted to that channel or chat.
- Find one person by email and send a 1:1 message. This needs the Graph flag (`MARKETPLACE_CHANNELS_TEAMS_GRAPH_ENABLED`) and the people policy of the connection. The app must be installed for that person.

Each of these is outward. It needs a standing grant with the related scope, or your approval of the exact message. The first message to a person always needs your approval.

Agents cannot do these things in Teams in this version: send files, images, cards or reactions. Marketplace never mentions a whole team, a channel or a tag.

Approvals stay in Teal Brick, Buzz and the Marketplace screen. Teams shows "waiting for owner approval" and never accepts an approval click.

## Rotate or remove

- To rotate the secret: make a new secret (step 2), update Account Connections, redeploy Marketplace, then delete the old secret in Entra.
- To stop all posts: remove the app from the team in Teams, or remove the credentials and redeploy. Marketplace marks the conversation removed when Teams tells it that the app was uninstalled.
