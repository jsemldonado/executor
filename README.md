# bodega

CI for Bodega's Executor image. The patch is the single commit on `bodega-approval-webhook`, on top of an upstream release tag. `.github/workflows/bodega-image.yml` builds it for linux/amd64 into `ghcr.io/jsemldonado/executor-selfhost:<version>-bodega.<n>` and, daily, moves the patch onto a newer upstream release, opening an issue when that conflicts.
