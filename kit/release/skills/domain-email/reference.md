# Domain email: reference

Written 2026-10-05 from setting up mail for two domains on a cPanel shared hosting plan. Panel names differ between
hosts and versions; the shape stays the same. Replace `example.com` with the user's domain.

## Read what is there first

```powershell
nslookup -type=MX  example.com 8.8.8.8
nslookup -type=TXT example.com 8.8.8.8
nslookup -type=TXT _dmarc.example.com 8.8.8.8
nslookup -type=TXT default._domainkey.example.com 8.8.8.8   # "default" is the usual cPanel selector
nslookup -type=NS  example.com 8.8.8.8
```

The name servers (`NS`) say which DNS host is in charge. Records added anywhere else have no effect.

## Records

| Record | Name | Example value | Note |
|---|---|---|---|
| `MX` | `example.com` | `0 mail.example.com` | or the provider's servers |
| SPF `TXT` | `example.com` | `v=spf1 +a +mx +ip4:<sending-ip> ~all` | one record; add `include:` for each extra sender |
| DKIM `TXT` | `<selector>._domainkey` | `v=DKIM1; k=rsa; p=…` | made by the panel or provider; copy, never invent |
| DMARC `TXT` | `_dmarc` | `v=DMARC1; p=none; adkim=r; aspf=r` | later `p=quarantine` |

`~all` (soft fail) is the safe start; `-all` only when every sender is listed for sure. The panel's "Email
Deliverability" page (cPanel) can install SPF and DKIM with one button when the panel's DNS is in charge.

## cPanel pages (other panels have the same ideas)

| Goal | Page |
|---|---|
| Mailboxes (the user creates them) | Email Accounts |
| SPF, DKIM, PTR status | Email Deliverability |
| Forward an address into another | Forwarders |
| Reply automatically | Autoresponders |
| Reject unknown addresses | Default Address: "Discard the email while your server processes it by SMTP time with an error message" |
| Local or remote delivery | Email Routing |
| Spam | Spam Filters: on, move to a spam folder, no auto-delete at first |
| Sort into folders | Email Filters |
| Read mail in the browser | Webmail (Roundcube): Settings for identities, signature, time zone |

## Mail apps (IMAP and SMTP)

| Kind | Server | Port | Security |
|---|---|---|---|
| Incoming (IMAP) | `mail.example.com` | 993 | SSL/TLS |
| Outgoing (SMTP) | `mail.example.com` | 465 | SSL/TLS |

The user name is the full address. The panel's "Connect devices" page shows the exact values and can mail them to
the mailbox.

## Reading a test message

In Gmail: open the message, the three-dot menu, "Show original". The top shows SPF, DKIM and DMARC with PASS or FAIL
and the domain each was checked against. The `Authentication-Results` header holds the same. DKIM should pass for
the user's own domain, not only for the host's.

## Problems

| Symptom | Usual cause |
|---|---|
| Mail lands in spam | SPF or DKIM fails; a brand-new domain (send a few normal mails over days); a sender name that looks like spam |
| SPF fails | two SPF records (merge them), or a sender missing from the one record |
| DKIM fails | the record was cut or changed when pasted; publish it again from the panel |
| The panel says SPF or DKIM "error" but Gmail says PASS | the panel's own DNS lookup failed (look for SERVFAIL in the message); check from outside, tell the host |
| Panel warns about PTR | the sending server's reverse DNS does not match its name: only the host can fix it |
| Mail to the domain bounces | `MX` points elsewhere, or routing is "remote" while mail is hosted locally |
| A forwarder loops or doubles | an address forwards to itself through another forwarder; draw the routes |
| Two webmail tabs sign each other out | one session per browser; use a private window for the second |
| Auto-replies answer spam | the auto-reply sends to every sender; keep it only on low-traffic addresses with a limit per sender |
