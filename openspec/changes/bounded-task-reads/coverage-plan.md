# Planned scenario map

These are future oracle allocations, not runnable test citations or claimed passes. Implementation must add literal test titles and @covers annotations for each row before result preflight. No metric/report scenario belongs to this slice.

| Requirement / scenario | Planned oracles |
| --- | --- |
| task_get subtasks are compact rows / Umbrella task subtasks | G1/G2/P3 |
| task_get subtasks are compact rows / Paging subtasks to the end | G1/G2/P3 |
| task_get subtasks are compact rows / Foreign subtask anchor | G1/G2/P3 |
| task_get message bodies are previews / Long instruction mail | G3–G5/H6/P3 |
| task_get message bodies are previews / Paging messages to the end | G3–G5/H6/P3 |
| task_get returns full message bodies on request / Default stays a preview | G3/G5a–c/H8 |
| task_get returns full message bodies on request / Asking for full bodies | G3/G5a–c/H8 |
| task_get returns full message bodies on request / Full bodies while paging | G3/G5a–c/H8 |
| task_get returns full message bodies on request / Non-boolean value | G3/G5a–c/H8 |
| task_get lists results as rows / Five results | G9–G9d/P3 |
| task_get lists results as rows / Long result history | G9–G9d/P3 |
| task_get lists results as rows / Result anchor not of this task | G9–G9d/P3 |
| task_get reads one result whole / Reading a superseded result | G10–G13g/H5 |
| task_get reads one result whole / Sealed reviewer asks for a result | G10–G13g/H5 |
| task_get reads one result whole / Large diff | G10–G13g/H5 |
| task_get reads one result whole / Diff fits the preview | G10–G13g/H5 |
| task_get reads one result whole / Result of another task | G10–G13g/H5 |
| task_result_diff_read returns any diff losslessly / Reading a diff-only result whole | G13a–f/P5 |
| task_result_diff_read returns any diff losslessly / Continuing a preview | G13a–f/P5 |
| task_result_diff_read returns any diff losslessly / Offset beyond the diff | G13a–f/P5 |
| task_result_diff_read returns any diff losslessly / Result without a diff | G13a–f/P5 |
| task_result_diff_read returns any diff losslessly / Foreign result | G13a–f/P5 |
| task_get assignment history is compact / Instruction appears once | G14/G15/H1 |
| task_get assignment history is compact / Long publication history | G14/G15/H1 |
| Remaining task histories have continuation anchors / Histories remain reachable | H1/H2/P3 |
| Remaining task histories have continuation anchors / Invalid history anchors | H1/H2/P3 |
| Task read identities survive paging and concurrent writes / Result superseded between pages | H3/H4/P6 |
| Task read identities survive paging and concurrent writes / New activity between pages | H3/H4/P6 |
| task_get bounds its growing lists / Long-running task read by an agent | G16/G17/P4; existing journal/revision regressions |
| task_get bounds its growing lists / Small task is whole | G16/G17/P4; existing journal/revision regressions |
| task_get bounds its growing lists / Results and revisions stay whole | G16/G17/P4; existing journal/revision regressions |
| task_get bounds its growing lists / Umbrella task fits a context | G16/G17/P4; existing journal/revision regressions |
| task_get bounds its growing lists / Human detail stays complete | G16/G17/P4; existing journal/revision regressions |
| Agents are told task_get is bounded / Prompt names the paging | H8/H9 |
| Agents are told task_get is bounded / Header stops promising the full journal | H8/H9 |
