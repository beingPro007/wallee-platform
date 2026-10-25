import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services/image-processing'))
from app.utils.observability import OperationTrace,safe_reference

class ObservabilityTests(unittest.TestCase):
    def test_url_reference_does_not_store_credentials_or_query(self):
        self.assertEqual(safe_reference('https://name:password@example.com/p/image?access_token=secret#private'),'https://example.com/p/image')
        self.assertEqual(safe_reference('pfp/image.jpg'),'pfp/image.jpg')

    def test_outage_does_not_raise_into_processing(self):
        client=Mock();client.table.side_effect=RuntimeError('offline')
        trace=OperationTrace('ingestion','https://pin.it/test',client=client)
        trace.stage('downloading','Download started')
        trace.finish('failed','Input unavailable')
        self.assertIsNone(trace.client)

    def test_recorded_file_failure_marks_otherwise_successful_run_partial(self):
        client=Mock();trace=OperationTrace('ingestion',client=client)
        trace.stage('processing','One image failed',{'error_type':'RuntimeError'},'error')
        trace.finish(details={'uploaded':4})
        writes=client.table.return_value.update.call_args_list
        self.assertEqual(writes[-1].args[0]['status'],'partial')
        self.assertIn('finished_at',writes[-1].args[0])

    def test_ingestion_download_failure_is_recorded_and_propagated(self):
        from app.services.etl import ETLService
        service=ETLService.__new__(ETLService)
        service._safe_cleanup=Mock()
        service._download_pinterest=Mock(side_effect=RuntimeError('downloader unavailable'))
        trace=Mock()
        with patch('app.services.etl.OperationTrace',return_value=trace),patch('app.services.etl.os.makedirs'):
            with self.assertRaisesRegex(RuntimeError,'downloader unavailable'):
                service.process_url('https://pin.it/test')
        trace.stage.assert_called_with('downloading','Downloading source media')
        trace.finish.assert_called_once_with('failed','Ingestion failed; inspect service logs for details',{'error_type':'RuntimeError'})

    def test_classifier_fallback_marks_operation_partial(self):
        from app.services.etl import ETLService
        service=ETLService.__new__(ETLService)
        service._classifier=Mock(side_effect=RuntimeError('database write failed'))
        client=Mock();service.trace=OperationTrace('ingestion',client=client)
        self.assertEqual(service._classify_image(b'image','image.jpg'),'misc')
        service.trace.finish()
        self.assertEqual(client.table.return_value.update.call_args_list[-1].args[0]['status'],'partial')
