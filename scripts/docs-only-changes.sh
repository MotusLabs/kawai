#!/bin/sh
# Exit 0 when every changed path is documentation, 1 when any is not, and 2
# when the changed paths cannot be listed.
#
#   docs-only-changes.sh            classify the staged index (pre-commit hook)
#   docs-only-changes.sh <range>    classify a commit range such as
#                                   base...head (CI skips e2e on docs-only PRs)
#
# Documentation means a markdown/text file, anything under openspec/ or docs/
# (specs, proposals, yaml metadata, images), or a root license/changelog file.
#
# --no-renames is load-bearing. With rename detection on, `git diff --name-only`
# reports only the destination of a rename, so moving a runtime source file
# into docs/ (or onto a .txt path) looks docs-only even though the commit
# removes that source from the application. Disabling detection lists both
# sides, and the source path forces the suite to run.
#
# A failed listing must never read as "no files, so docs-only": callers treat
# exit 2 like "not docs-only" and keep running their checks.

if [ $# -eq 0 ]; then
	files=$(git diff --cached --no-renames --name-only) || exit 2
else
	files=$(git diff --no-renames --name-only "$1") || exit 2
fi

while IFS= read -r file; do
	[ -n "$file" ] || continue
	case "$file" in
	*.md | *.mdx | *.txt | *.rst) ;;
	openspec/* | docs/*) ;;
	LICENSE | LICENSE.* | COPYING | NOTICE | AUTHORS | CHANGELOG | CHANGELOG.*) ;;
	*)
		exit 1
		;;
	esac
done <<EOF
$files
EOF

exit 0
