# 05 — Troubleshooting

| Symptom                       | Likely cause                                             | Fix                                                                                    |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Status blank after Success    | `Update Status` value empty / Email mismatch / wrong gid | Verify mapping has Email+Status, matching on `Email`, trim spaces, same doc/tab as Get |
| 401 both nodes                | Placeholder not replaced / revoked                       | Update both HTTP headers, same key with `Bearer ` prefix                               |
| 402                           | No paid plan                                             | Upgrade, rerun blanks                                                                  |
| 403                           | Missing `accounts:create` scope                          | Recreate key read+write                                                                |
| 429                           | Too fast                                                 | Keep batch 1, add Wait, rerun blanks                                                   |
| 400 / NaN ports               | Text in port cells                                       | Ensure `993`/`587` numeric, code casts `Number()`                                      |
| 404 on Check treated as error | Expected new-account path                                | Confirm `onError: continueErrorOutput` routes to Add                                   |
| Duplicates attempted          | Email case/space variant                                 | Workflow lowercases/trims; dedupe sheet by Email                                       |
| Google 403                    | Sheet not shared                                         | Share + reconnect OAuth                                                                |

Debug: pin single item, inspect `$json.error` full body, check execution log. `Status` values: `Added` success/exists, `Failed - message` truncated 200 chars.
