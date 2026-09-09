import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"supervisor"))
from mirrorgate.control_server import _Output, _secure_parent, serve_stream


class Backend:
    instance_id="e"*32
    def capability_reports(self,mode): return ({"id":"control.local-stdio-v1","available":True,"enforcedScope":"connection","limits":{}},)
    def cleanup_session(self,*args,**kwargs): raise AssertionError("no session exists")

class ServerTests(unittest.TestCase):
    def test_stdio_hello_and_argument_failure_keep_correlation(self):
        hello={"v":1,"kind":"request","id":1,"op":"hello","args":{"controlVersions":[1],"requiredCapabilities":[]}}
        invalid={"v":1,"kind":"request","id":2,"op":"session.status","args":{"sessionId":"bad"}}
        reader=io.BytesIO((json.dumps(hello,separators=(",",":"))+"\n"+json.dumps(invalid,separators=(",",":"))+"\n").encode())
        writer=io.BytesIO(); serve_stream(reader,writer,Backend(),principal_uid=os.geteuid(),connection_mode="stdio")
        replies=[json.loads(line) for line in writer.getvalue().splitlines()]
        self.assertEqual([reply["id"] for reply in replies],[1,2])
        self.assertTrue(replies[0]["ok"]); self.assertEqual(replies[1]["error"]["code"],"ARGUMENT_INVALID")

    def test_handshake_failure_is_structured_then_terminal(self):
        hello={"v":1,"kind":"request","id":1,"op":"hello","args":{"controlVersions":[3],"requiredCapabilities":[]}}
        later={"v":1,"kind":"request","id":2,"op":"hello","args":{"controlVersions":[1],"requiredCapabilities":[]}}
        writer=io.BytesIO();serve_stream(io.BytesIO((json.dumps(hello)+"\n"+json.dumps(later)+"\n").encode()),writer,Backend(),principal_uid=os.geteuid(),connection_mode="stdio")
        replies=writer.getvalue().splitlines();self.assertEqual(len(replies),1)
        self.assertEqual(json.loads(replies[0])["error"]["code"],"VERSION_UNSUPPORTED")

    def test_duplicate_key_and_unterminated_frame_close_silently(self):
        for data in (b'{"v":1,"v":1}\n',b'{"v":1}'):
            with self.subTest(data=data):
                writer=io.BytesIO(); serve_stream(io.BytesIO(data),writer,Backend(),principal_uid=os.geteuid(),connection_mode="stdio")
                self.assertEqual(writer.getvalue(),b"")

    def test_partial_hello_deadline_does_not_wait_for_eof(self):
        read_fd,write_fd=os.pipe(); reader=os.fdopen(read_fd,"rb",buffering=0); writer=io.BytesIO()
        os.write(write_fd,b'{"v":1')
        thread=threading.Thread(target=serve_stream,args=(reader,writer,Backend()),kwargs={"principal_uid":os.geteuid(),"connection_mode":"stdio","frame_timeout":.05})
        thread.start();thread.join(.5)
        try:
            self.assertFalse(thread.is_alive());self.assertEqual(writer.getvalue(),b"")
        finally:
            os.close(write_fd);reader.close()

    def test_slow_socket_reader_overflow_stops_nonblocking_writer(self):
        import socket,time
        server,client=socket.socketpair(); writer=server.makefile("wb",buffering=0); stop=threading.Event(); output=_Output(writer,stop)
        try:
            message={"v":1,"kind":"event","seq":1,"sessionId":"1"*32,"event":"authoring.output","data":{"operationId":1,"stream":"stdout","chunk":1,"bytesBase64":"a"*900000}}
            for _ in range(6): output.send(message)
            self.assertTrue(stop.wait(1)); output.close(timeout=1)
            self.assertFalse(output.thread.is_alive())
        finally:
            writer.close();server.close();client.close()

    def test_unix_path_requires_owned_0700_nonsymlink_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent=Path(tmp)/"control"; parent.mkdir(mode=0o700)
            _secure_parent(parent/"gate.sock",os.geteuid())
            parent.chmod(0o755)
            with self.assertRaises(ValueError): _secure_parent(parent/"gate.sock",os.geteuid())
            parent.chmod(0o700); alias=Path(tmp)/"alias"; alias.symlink_to(parent,target_is_directory=True)
            with self.assertRaises(ValueError): _secure_parent(alias/"gate.sock",os.geteuid())

if __name__=="__main__":unittest.main()
