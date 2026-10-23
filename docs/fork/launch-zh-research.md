# Overseas-Chinese launch research

Checked 22 October 2026. Public pages only: no app binary, prompt, or design file was read, and none is copied here. This is a product note, not a legal opinion.

Audience: invited Chinese-speaking users in Taiwan, Hong Kong, Singapore, and Malaysia. Models: Anthropic and OpenAI via API keys, from a server outside mainland China. Maka Cloud is a software employee, not a life assistant. **Must** is before the first invite, or before the build that person installs. **Wait** is after that.

## 1. Today AI (todayai.cn)

Two public sites. [todayai.cn](https://todayai.cn/) is the China site. [today.ai](https://today.ai/) is the international site. A 28 September 2026 review that read both agreements treats them as different operators: Singapore law on the international text it read, mainland law and mainland storage on the China text. ([Geeyo](https://www.geeyo.com/today-%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90%EF%BC%9A%E9%BD%90%E4%BF%8A%E5%85%83%E7%9A%84%E4%B8%AA%E4%BA%BA-ai-%E5%8A%A9%E7%90%86%EF%BC%8C%E6%B3%A8%E5%86%8C%E9%80%81-1-%E4%BA%BF-token%E3%80%81%E4%BC%A0/))

**Position.** A personal assistant (个人 AI 助理) with living memory (鲜活记忆) that acts before the user asks. Press names the founder as Qi Junyuan (齐俊元). ([AITNT, 30 Sep](https://www.aitntnews.com/newDetail.html?newId=29892))

**Features.** Both homepages show chat, a Today panel (a morning brief and the day's items), memory, and tasks. The China page's fifth tab is a named companion (the demo uses Spark). The international page's is Capabilities. Memory is days, people, preferences, and goals, and the user controls it. Proactive help nudges when something changes. Tasks are planned, tooled, and reported. Connectors cover calendar, mail, notes, files, chat, and project tools. The China page adds a cloud computer (云端电脑: browser, files, and code, including while the user is away) and community skills (社区技能), naming deep research, HRV, and meeting notes.

**Onboarding and voice.** The demo greets the user by name, says it already knows a little, and offers chips across design, travel, health, and language study. Sign-in is email or single sign-on, then a short onboarding. ([Support](https://today.ai/support)) Connectors are staged and revocable, and an external send waits for a confirm. ([What is Today](https://today.ai/articles/blog/what-is-today)) A 22 October interview says to ask for a permission only when needed, keep memory visible and deletable, leave payment with the user, and quieten nudges nobody reads. ([Techub](https://www.techub.news/articles/edf296c4-6519-4adc-91ca-4f47104fef30)) China-site Chinese is Simplified, warm, and short. The product is 「Today」. The companion can take a personal name. ([Geekpark, via Ifeng](https://feng.ifeng.com/c/8x51MXKiO5T))

**Price and platforms.** On 22 October the China homepage offered 300 million tokens, three months of Pro, and a free basic tier (基础版永久免费). Late September said 100 million tokens and one month. The international blog (15 September) still says the product is free. Geeyo's 28 September reading of an in-app sheet, not the homepage, described Free, Pro (~US$20), Ultra (~US$200), a 7-day Pro trial, and no Ultra trial, and said uninstall does not cancel auto-renew. Desktops: Mac (macOS 14+), Windows 10+, Linux. China mobile is the App Store plus an APK. International mobile is the App Store, Play, and a browser extension. ([China](https://todayai.cn/downloads), [international](https://today.ai/downloads))

**Praise and complaints.** Praise: a task that resumes the next day with no new instruction; memory the user can view, edit, and delete; a brief that stays in a panel; regional connectors (Feishu, DingTalk, Tencent Docs, and mail in China; Gmail, Calendar, Notion, and Slack internationally). ([AITNT, 30 Sep](https://www.aitntnews.com/newDetail.html?newId=29892)) Complaints: a wrong nudge feels like nagging ([AITNT, 8 Sep](https://www.aitntnews.com/newDetail.html?newId=29110)); the first 72 hours argued about a broad local scan (全盘扫描, [SMZDM](https://post.smzdm.com/p/anv3g553/)); a wrong inference sticks until edited; the China policy Geeyo read includes health, voice, and the clipboard. Late-September iOS ratings were a handful of scores.

### Borrow, and leave

Borrow: open on the task and its approval, not an empty composer (proposed cards stay off, `docs/fork/launch-notes.md`); work memory the user can open, correct, and delete; one connector at a time, the code host this week; a person approves a side effect; ignored nudges get quieter; short concrete Chinese that names the role; enough budget on the invite to finish one task.

Leave: life scope (sleep, pets, travel, savings, HRV) and the sensitive-data rules that come with it; a claim to know the user before they have spoken; a broad disk or photo scan; a skill store and lifestyle deep research (deep mode stays off); auto-renew that survives uninstall; their sentences, screens, and skill text.

## 2. Launch requirements

### 2.1 API regions

Checked 22 October 2026 against [Anthropic's supported-regions page](https://www.anthropic.com/legal/supported-regions) and [OpenAI's API country list](https://developers.openai.com/api/docs/supported-countries).

| Place | Anthropic API | OpenAI API |
| --- | --- | --- |
| Taiwan, Singapore, Malaysia | Listed | Listed |
| Hong Kong, Macau, mainland China | Absent | Absent |

Anything absent is unsupported. Anthropic's page covers the API, and it counts three cases: a person physically in an unlisted place, a company incorporated or headquartered there (and that company's users, wherever they sit), and a company majority-controlled from there. OpenAI says accessing **or offering access** outside the list may suspend the account. A Singapore server does not cure a user in Hong Kong, including a Taiwan user travelling there. A Hong Kong company holding the keys would make every call unsupported.

**Must.** Block sign-up and each later model call for Hong Kong, Macau, and mainland China, by current IP and by account country. Re-check on travel. Do not suggest a VPN. Put the API contract on a company incorporated in a listed country. Taiwan, Singapore, and Malaysia can proceed. **Wait:** a polished travel screen. A one-line block is enough.

### 2.2 Privacy policy and terms

| Law | Notice | This invite |
| --- | --- | --- |
| Taiwan PDPA art. 8 | Who; purpose; categories; period, territory, recipients, method; art. 3 rights; effect of refusing | No art. 6 health data. Nov 2025 breach-report amendment has no start date. Offshore collectors of Taiwanese nationals can be in scope. |
| Hong Kong PDPO | DPP1 purpose and limited collection. DPP5 a policy people can read | Section 33 is not in force. No statutory breach clock. 2024 AI framework: purpose, human oversight, named overseas cloud. The section 2.1 block keeps most of this off the invite. |
| Singapore PDPA | Purposes on or before collection; consent or an exception; access and correction; a published contact | Section 26: comparable protection by contract, rules, certification, or informed consent. Notifiable breach: PDPC within 3 calendar days; people if harm is likely. 500 is significant scale. No local office required. |
| Malaysia PDPA | Written notice in Bahasa Malaysia and English. Chinese replaces neither | Since 1 Jun 2025: Commissioner within 72 hours, the person within 7 days of that notice if harm is likely. Whitelist gone. DPO duty follows the Feb 2025 thresholds. |

Sources: [Taiwan statute](https://law.pdpc.gov.tw/LawContent.aspx?id=FL010627), [Law.asia](https://law.asia/taiwan-tmt-laws-ai-data-protection-cybersecurity/), [Chambers](https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/taiwan), [Cap. 486](https://www.elegislation.gov.hk/hk/cap486), [PCPD](https://www.pcpd.org.hk/english/data_privacy_law/6_data_protection_principles/principles.html), [section 33 note](https://www.awlawyers.co/blog/cross-border-data-transfers-hong-kong-pdpo-guide), [AI framework](https://www.pcpd.org.hk/english/resources_centre/publications/files/ai_protection_framework.pdf), [Singapore Act](https://sso.agc.gov.sg/Act/PDPA2012), [PDPC](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act), [Malaysia dates](https://www.christopherleeong.com/viewpoints/news-alert-dates-of-coming-into-operation-of-the-personal-data-protection-amendment-act-2024/), [DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=MY).

Shared clauses: legal name, address, and a published contact. Data: email, invite, chat, repo contents, task logs, device, IP, approvals. Purpose: run the agent, keep work memory, open pull requests, secure the service. Territory and recipients: the host country, Anthropic, and OpenAI. Commercial API terms do not train on that data unless the customer opts in. Abuse logs run about 30 days. ([OpenAI](https://openai.com/enterprise-privacy/); [API controls](https://developers.openai.com/api/docs/guides/your-data); [Anthropic](https://www.anthropic.com/legal/commercial-terms)) The user owns the code. A person approves a pull request. Rights: access, correction, deletion. Age 18. Governing law matches the section 2.1 entity.

**Language. Must:** English and Traditional Chinese (繁體中文) before a Taiwan invite, because an article 8 notice has to be readable. Bahasa Malaysia and English before a Malaysia invite. Simplified Chinese (简体中文) for a Singapore or Malaysia reader who is not comfortable in English. English alone meets the Singapore duty for an English reader. The consent screen ships with the notice. The rest of the UI can follow. **Wait:** a paid-plan contract, Taiwan's 7-day cooling-off, and a JPDP registration analysis. The Malaysia notice still applies to a small invite.

### 2.3 Phone apps

Ship the web app without waiting on a store. Both stores work in all four markets. Skip Hong Kong testers because of section 2.1.

**TestFlight, for anyone outside the developer team.** Internal testing (up to 100) skips review and requires an App Store Connect role, so it is the wrong tool for customers. External testing is the invite: email or a public link, up to 10,000. The first build of a version goes through Beta App Review. Later builds of that version often do not. Builds last 90 days. ([Overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/); [invites](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)) Apple publishes no clock. Queues through 26 September 2026 averaged about 8.5 hours waiting plus 1.5 hours in review, with a tail past a day. ([asoitis.com](https://asoitis.com/blog/app-store-review-time)) Attach a privacy URL, age rating, export answer (ordinary HTTPS is exempt), feedback email, and a demo account. ([Export](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)) Use email, not a public link.

**Play internal testing.** Up to 100 emails. A new bundle is described as ready within minutes, while the first opt-in link can take several hours, and a first upload shows a temporary name for up to 48 hours. Testers need a Google account and can be in a country where production is off. The track may skip policy review, and the Data safety form is not required. ([Help](https://support.google.com/googleplay/android-developer/answer/9845334)) Accounts opened after 13 November 2023 need 12 closed testers for 14 days before production. That gate is not this invite. ([Requirements](https://support.google.com/googleplay/android-developer/answer/14151465))

**Must** for a phone build outside the team: external TestFlight by email, and the Play internal track, after the developer accounts exist. A new account's identity check is the long pole. **Wait:** production listings and the 14-day gate.

### 2.4 Sign-in and mail

Sign in with Apple works in all four places, including on the web and on Android. Apple's two-factor list includes their phone numbers. ([List](https://support.apple.com/en-us/102333); [Sign in with Apple](https://support.apple.com/en-us/102609)) Google Sign-In works in all four.

Guideline 4.8: a third-party login that creates the account needs a paired option that takes only name and email, lets the user hide the email, and does not track the app for ads without consent. Sign in with Apple meets it. An iOS build that shows Google without that option is a likely first-build rejection. An email code alone does not trigger 4.8. ([Guidelines](https://developer.apple.com/app-store/review/guidelines/))

Delivery is the risk. Gmail, Outlook, iCloud, and Yahoo cover most inboxes, and Taiwan still has ISP mail that treats a new domain as spam. Register the domain for Apple's private relay if Hide My Email is on, or `@privaterelay.appleid.com` bounces. ([Relay](https://developer.apple.com/help/account/configure-app-capabilities/configure-private-email-relay-service/)) **Must:** SPF, DKIM, DMARC, and one test to those four inboxes. **Wait:** SMS. Each place has sender-ID registration.

### 2.5 Also this week

One breach note, written to Malaysia's 72 hours for a significant breach and Singapore's three calendar days after the assessment. Taiwan's new duty has no start date. Hong Kong's is guidance. Guideline 5.1.1(v) requires in-app deletion when an iOS build creates accounts. The web invite can name a deletion address in the policy. OpenAI's usage policy, updated 21 October 2026, forbids training a substitute model on API outputs. ([Usage policies](https://openai.com/policies/usage-policies/)) Take no card. Invite by name, with no public TestFlight link and no Play open track.

## 3. Checklist

| Item | Tag |
| --- | --- |
| Block Hong Kong, Macau, and mainland China on sign-up and on each model call | Must |
| API customer incorporated in a listed country | Must |
| Policy and terms with the shared clauses in section 2.2 | Must |
| English and Traditional Chinese | Must |
| Simplified Chinese where the reader needs it | Must for those invites |
| Bahasa Malaysia and English | Must for a Malaysia invite |
| Published privacy contact | Must |
| SPF, DKIM, DMARC, and a four-inbox test | Must |
| Email code; Apple and Google both available | Must |
| Sign in with Apple beside Google on iOS | Must before that build |
| In-app deletion, demo account, privacy URL, export answer | Must before external TestFlight |
| External TestFlight by email; budget up to 48 hours | Must if iOS this week |
| Play internal track | Must if Android this week |
| Breach note written to the 72-hour clock | Must |
| Work memory the user can open, correct, and delete | Must |
| No training on API outputs | Must |
| Public store, payments, SMS, life connectors, deep mode | Wait |
