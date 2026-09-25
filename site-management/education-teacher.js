(function(){
'use strict';
window.addEventListener('DOMContentLoaded',()=>{
 const prior=window.safetyForm;
 window.safetyForm=function(kind,sid,id){prior(kind,sid,id);if(!['common','induction'].includes(kind))return;const f=document.getElementById('safetyForm'),input=f?.elements.teacher;if(!input)return;const previous=input.value,select=document.createElement('select');select.name='teacher';select.required=true;select.innerHTML='<option value="">今回の教育担当者を選択</option>';const people=siteResolvedMembers(sid);for(const person of people){const value=person.name+' ／ '+(person.code||person.id);const option=new Option(value,value);select.add(option)}if(previous&&![...select.options].some(o=>o.value===previous))select.add(new Option(previous+'（保存済み）',previous));select.value=previous;input.replaceWith(select);const note=document.createElement('p');note.textContent='今回教育した人を選びます。現場の職長・教育管理者の権限は変わりません。';select.after(note);
 };
});
})();
