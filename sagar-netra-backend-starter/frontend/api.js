const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
export async function apiRequest(path,{token,method='GET',body,isForm=false}={}) {
 const headers={}; if(token) headers.Authorization=`Bearer ${token}`;
 if(body&&!isForm) headers['Content-Type']='application/json';
 const res=await fetch(`${API_URL}${path}`,{method,headers,body:body?(isForm?body:JSON.stringify(body)):undefined});
 const data=await res.json().catch(()=>({}));
 if(!res.ok) throw new Error(data.error||`Request failed (${res.status})`);
 return data;
}
export const register=payload=>apiRequest('/auth/register',{method:'POST',body:payload});
export const login=payload=>apiRequest('/auth/login',{method:'POST',body:payload});
export const getMe=token=>apiRequest('/users/me',{token});
export const getReports=token=>apiRequest('/reports',{token});
export const getReport=(token,id)=>apiRequest(`/reports/${id}`,{token});
export const submitReport=(token,formData)=>apiRequest('/reports',{token,method:'POST',body:formData,isForm:true});
export const saveDetections=(token,id,detections)=>apiRequest(`/reports/${id}/detections`,{token,method:'POST',body:{detections}});
