"""Scope-aware acceptance tooling; local synthetic metadata is never algorithm proof."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools import acceptance as acceptance
from tools import gen_docs


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.acc = self.root/'docs/acceptance'
        self.acc.mkdir(parents=True)
        for name, content in [('web/tests/current.test.mjs', 'test source'), ('web/js/client.js', 'client source'),
                              ('tools/acceptance.py', 'tool source')]:
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
        self.identity = 'FL-ORCH-01'
        master = {'items': [{'id':self.identity, 'l1':'FL', 'l2':'project', 'l3':'create', 'desc':'requirement', 'source':'V5', 'route':'#/fed/orch'}],
                  'contract': [{'id':'C-01', 'module':'FL', 'name':'project', 'desc':'contract reference', 'maps':[self.identity]}]}
        self.write('items.json',master)
        self.write('fed-orch.json',{self.identity:{'status':'done','steps':[],'api':[],'impl':'historical mapping'}})
        self.scope = patch.multiple(acceptance, ROOT=self.root, ACC=self.acc, OUT=self.root/'dist/acceptance')
        self.scope.start(); self.addCleanup(self.scope.stop)

    def write(self, name, value):
        (self.acc/name).write_text(json.dumps(value))

    def unit(self):
        result = acceptance.parse_tap('ok 1 - [FL-ORCH-01] isolated client case\n', 0)
        result['source_sha256'] = acceptance.source_digest()
        return result

    def test_tap_skip_and_todo_are_not_passing_cases(self):
        result = acceptance.parse_tap('ok 1 - [FL-ORCH-01] one\nok 2 - [DP-MECH-01] two # SKIP missing runtime\n'
            'not ok 3 - [MPC-OPS-01] three\nnot ok 4 - fourth # TODO later\n', 1)
        self.assertEqual((result['total'],result['passed'],result['failed'],result['skipped'],result['todo']), (4,1,1,1,1))
        self.assertFalse(result['by_id']['DP-MECH-01'][0]['pass'])
        self.assertEqual(result['scope'],'real-client-isolated-unit')

    def test_current_unit_cannot_promote_historical_mock_browser_results(self):
        self.write('e2e-results.json',{'by_id':{self.identity:{'pass':True}}})
        rows,_ = acceptance.build(self.unit())
        self.assertEqual(rows[0]['state'],'testing')
        self.assertIsNone(rows[0]['e2e'])

    def test_matching_browser_scope_and_digest_are_required_for_frontend_verified_state(self):
        unit = self.unit()
        self.write('e2e-results.json',{'scope':'real-backend-browser','source_sha256':unit['source_sha256'],
                                      'by_id':{self.identity:{'pass':True}}})
        rows,_=acceptance.build(unit)
        self.assertEqual(rows[0]['state'],'done')
        (self.root/'web/js/client.js').write_text('changed after evidence')
        rows,_=acceptance.build(unit)
        self.assertNotEqual(rows[0]['state'],'done')

    def test_no_test_rejects_legacy_or_stale_cache_without_launching_node(self):
        self.write('unit-results.json',{'total':106,'failed':0,'by_id':{self.identity:[{'pass':True}]}})
        with patch.object(acceptance.subprocess,'run',side_effect=AssertionError('must not launch Node')),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(acceptance.main(['--no-test']),2)

    def test_node_failure_generates_honest_report_and_nonzero_exit(self):
        failed=SimpleNamespace(returncode=1,stdout='not ok 1 - [FL-ORCH-01] actual failed case\n',stderr='unit failure')
        self.write('e2e-results.json',{'by_id':{self.identity:{'pass':True}}})
        output=self.root/'report'
        with patch.object(acceptance.subprocess,'run',return_value=failed),patch.object(acceptance,'write_xlsx'),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(acceptance.main(['--output',str(output)]),1)
        report=json.loads((output/'status.json').read_text())
        self.assertEqual(report['unit']['failed'],1)
        self.assertTrue(report['historical_browser_records_ignored'])
        self.assertEqual(report['items'][0]['state'],'fail')
        self.assertEqual(report['scope'],'frontend-evidence-only')

    def test_no_cases_and_no_test_files_are_not_success(self):
        with self.assertRaisesRegex(ValueError,'没有产生'):
            acceptance.parse_tap('TAP version 13\n1..0\n',0)
        (self.root/'web/tests/current.test.mjs').unlink()
        with self.assertRaisesRegex(ValueError,'没有当前客户端测试'):
            acceptance.run_unit_tests()

    def test_document_generator_does_not_resurrect_old_mock_pass_results(self):
        self.write('unit-results.json',{'total':106,'failed':0,'by_id':{self.identity:[{'pass':True}]}})
        self.write('e2e-results.json',{'by_id':{self.identity:{'pass':True}}})
        with patch.object(gen_docs,'ACC',self.acc):
            master,rows,unit,e2e,_=gen_docs.data()
        self.assertEqual(unit['total'],0)
        self.assertFalse(rows[0]['passed'])
        self.assertEqual(e2e['by_id'],{})
        self.assertIn('缺当前前端映射证据',gen_docs.contract_status(master['contract'][0],{self.identity:rows[0]}))
        report = gen_docs.report_md(master,rows,unit,e2e,'')
        manual = gen_docs.manual_md(master,rows)
        self.assertIn('不证明129接口',report)
        self.assertNotIn('内置服务（mock）',report)
        self.assertNotIn('演示数据保存在当前浏览器',manual)
        self.assertIn('不作为当前部署验收结论',manual)


if __name__=='__main__':
    unittest.main()
