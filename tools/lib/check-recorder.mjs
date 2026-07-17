// tools/lib/check-recorder.mjs — shared pass/fail check recorder for the
// non-P2P Playwright acceptance runners.
//
// The per-suite console formats predate this module and are pinned (CI logs
// are read by humans, and each suite's output style is already familiar) —
// the options below reproduce each runner's exact pre-existing output rather
// than inventing a new one.

const DETAIL_STYLES = {
    paren: (d) => `   (${d})`,     // "name   (detail)"
    dash: (d) => ` — ${d}`,        // "name — detail"
    'wide-dash': (d) => `  — ${d}`, // "name  — detail"
};

// createRecorder({ indent, detailStyle, detailOnPass, emptyDetailOnFail })
//   indent            prefix before the ✓/✗ mark ('  ', ' ', or '')
//   detailStyle       'paren' | 'dash' | 'wide-dash'
//   detailOnPass      print the detail even when the check passed
//   emptyDetailOnFail print the detail separator on failures even when the
//                     detail string is empty (bridge/ui historical format)
//
// → { checks, check(name, ok, detail), record(n, name, ok, detail),
//     summarize({ style, label }) → exit code }
export function createRecorder({
    indent = '  ',
    detailStyle = 'paren',
    detailOnPass = false,
    emptyDetailOnFail = false,
} = {}) {
    const checks = [];
    const fmt = DETAIL_STYLES[detailStyle];

    const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };
    // Numbered variant (acceptance.mjs): checks print sorted by n.
    const record = (n, name, ok, detail) => { checks.push({ n, name, ok, detail: detail || '' }); };

    // Prints the per-check lines, then the summary; returns the process exit
    // code (0 iff every check passed). Summary styles:
    //   'all-passed'  "All <label> checks passed." / "<n> check(s) FAILED."
    //   'ratio'       "<pass>/<total> <label> checks passed"
    //   'counts'      " <pass> passed, <fail> failed"
    function summarize({ style, label } = {}) {
        if (checks.some((c) => c.n !== undefined)) checks.sort((a, b) => a.n - b.n);
        let pass = 0, fail = 0;
        for (const c of checks) {
            const mark = c.ok ? '✓' : '✗';
            const num = c.n !== undefined ? `${c.n}.  ` : '';
            const showDetail = (detailOnPass || !c.ok) && (c.detail || (emptyDetailOnFail && !c.ok));
            console.log(`${indent}${mark} ${num}${c.name}${showDetail ? fmt(c.detail) : ''}`);
            c.ok ? pass++ : fail++;
        }
        if (style === 'ratio') {
            console.log(`\n${pass}/${pass + fail} ${label} checks passed`);
        } else if (style === 'counts') {
            console.log(`\n ${pass} passed, ${fail} failed`);
        } else {
            console.log('');
            console.log(fail ? `${fail} check(s) FAILED.` : `All ${label} checks passed.`);
        }
        return fail === 0 ? 0 : 1;
    }

    return { checks, check, record, summarize };
}
