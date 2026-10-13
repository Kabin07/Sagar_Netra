import {useState} from 'react';
import ReportLocation from './ReportLocation.jsx';
import {submitReport} from './api.js';
export default function ExampleReportForm({token,onSubmitted}) {
 const [location,setLocation]=useState({latitude:'',longitude:''}),[image,setImage]=useState(null),[comments,setComments]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function handleSubmit(e){e.preventDefault();setBusy(true);setMessage('');try{const form=new FormData();form.append('latitude',location.latitude);form.append('longitude',location.longitude);form.append('comments',comments);if(image)form.append('image',image);const result=await submitReport(token,form);setMessage(`Report ${result.report.report_id} saved.`);onSubmitted?.(result.report)}catch(err){setMessage(err.message)}finally{setBusy(false)}}
 return <form onSubmit={handleSubmit}><h2>Submit underwater report</h2><ReportLocation value={location} onChange={setLocation}/><label>Image (JPG/PNG/WebP)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setImage(e.target.files?.[0]||null)}/></label><label>Comments<textarea maxLength={5000} value={comments} onChange={e=>setComments(e.target.value)}/></label><button disabled={busy}>{busy?'Saving…':'Save report'}</button><p role="status">{message}</p></form>;
}
