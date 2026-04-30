# Trust model

Klura runs sessions in-process — browser contexts are logically isolated but share a single Chrome process and the daemon's Node runtime. There's no kernel boundary between sessions; the threat model assumes you trust the skills you're running.

The daemon itself runs with the user's permissions and manages `~/.klura` (skills, cookies, config). A malicious skill could exfiltrate data via its API calls during execution. The mitigation is community vetting and the skill registry's review process.
