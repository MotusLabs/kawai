#!/bin/sh
# Exit 0 when every staged path is documentation, 1 when any is not.
#
# Documentation means a markdown/text file, anything under openspec/ or docs/
# (specs, proposals, yaml metadata, images), or a root license/changelog file.
#
# --no-renames is load-bearing. With rename detection on, `git diff --name-only`
# reports only the destination of a rename, so moving a runtime source file
# into docs/ (or onto a .txt path) looks docs-only even though the commit
# removes that source from the application. Disabling detection lists both
# sides, and the source path forces the suite to run.

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
$(git diff --cached --no-renames --name-only)
EOF

exit 0
