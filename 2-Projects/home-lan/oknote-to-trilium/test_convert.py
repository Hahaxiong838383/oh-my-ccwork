import unittest,sys,pathlib,base64,json,zipfile
ROOT=pathlib.Path(__file__).parent
for p in ROOT.glob('*.whl'):
 sys.path.insert(0,str(p))
from convert import Converter,assert_text_preserved
class Tests(unittest.TestCase):
 def cv(self):return Converter({'old':'new'},{'a':{'id':'target','name':'x.png'}})
 def test_nested_table_text_and_span(self):
  d={'type':'doc','content':[{'type':'table','content':[{'type':'tableRow','content':[{'type':'tableCell','attrs':{'colspan':2},'content':[{'type':'paragraph','content':[{'type':'text','text':'中文 & < >','marks':[{'type':'bold'}]}]}]}]}]}]}
  b=('<!-- oknote:json:'+base64.b64encode(json.dumps(d).encode()).decode()+' -->').encode();html=self.cv().convert(b);assert_text_preserved(b,html);self.assertIn('colspan="2"',html);self.assertIn('&lt;',html)
 def test_checked_state(self):
  node={'type':'taskItem','attrs':{'checked':True},'content':[{'type':'paragraph','content':[{'type':'text','text':'done'}]}]};h=self.cv().render(node);self.assertIn('checked="checked"',h);self.assertIn('done',h)
 def test_missing_attachment_stops(self):
  with self.assertRaises(AssertionError):self.cv().render({'type':'image','attrs':{'src':'attachment:missing'}})
 def test_link_remap_and_image(self):
  c=self.cv();self.assertEqual(c.url('#/embed/editor?noteId=old'),'#root/new');self.assertIn('/target/image/x.png',c.render({'type':'image','attrs':{'src':'attachment:a'}}));self.assertEqual(c.refs,{'a'})
 def test_unknown_node_stops(self):
  with self.assertRaises(AssertionError):self.cv().render({'type':'unknown'})
 def test_missing_text_detection(self):
  b=('<!-- oknote:json:'+base64.b64encode(json.dumps({'type':'doc','content':[{'type':'text','text':'must preserve'}]}).encode()).decode()+' -->').encode()
  with self.assertRaises(AssertionError):assert_text_preserved(b,'<p>lost</p>')
 def test_math_delimiters(self):
  self.assertEqual(self.cv().render({'type':'mathInline','attrs':{'latex':'x<y'}}),'<span class="math-tex">\\(x&lt;y\\)</span>')
if __name__=='__main__':unittest.main()
