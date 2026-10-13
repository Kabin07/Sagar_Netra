import {useState} from 'react';
export default function ReportLocation({value,onChange}) {
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const coords=value||{latitude:'',longitude:''};
 function useGps(){
  if(!navigator.geolocation){setMessage('GPS unavailable; enter coordinates manually.');return}
  setBusy(true);setMessage('');
  navigator.geolocation.getCurrentPosition(p=>{onChange({latitude:String(p.coords.latitude),longitude:String(p.coords.longitude)});setMessage(`Location received; accuracy about ${Math.round(p.coords.accuracy)} m.`);setBusy(false)},e=>{setMessage(e.message+' You can enter coordinates manually.');setBusy(false)},{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
 }
 const update=(k,v)=>onChange({...coords,[k]:v});
 return <fieldset><legend>Report location</legend><button type="button" onClick={useGps} disabled={busy}>{busy?'Getting location…':'Use my current location'}</button><p role="status">{message}</p><label>Latitude <input type="number" min="-90" max="90" step="any" required value={coords.latitude} onChange={e=>update('latitude',e.target.value)}/></label><label>Longitude <input type="number" min="-180" max="180" step="any" required value={coords.longitude} onChange={e=>update('longitude',e.target.value)}/></label></fieldset>;
}
