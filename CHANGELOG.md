# Changelog

## 1.0.1

- `downloadAll.defaultDestination` now takes precedence over the folder used for the previous download. It had no effect once anything had been downloaded.
- Marketplace page: demo, install instructions, more keywords.

## 1.0.0

- First release: **Download All…** in the Explorer context menu downloads a multi-selection to one chosen folder.
- One destination prompt for the whole selection, instead of one dialog per item.
- Parallel transfers with progress and cancellation.
- Conflict handling per item or for the whole batch: overwrite, keep both, or skip.
- Settings: `downloadAll.onConflict`, `downloadAll.defaultDestination`, `downloadAll.concurrency`.
