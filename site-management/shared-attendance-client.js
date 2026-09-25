(function(root){'use strict';
class AttendanceClient{constructor({bridge,identity}){this.bridge=bridge;this.identity=identity;this.generation=0;}invalidate(){this.generation++;}async read(site,month,after=null,snapshot=null){const generation=this.generation,owner=JSON.stringify(this.identity());if(!this.identity())throw Error('ログインしてください');const data=await this.bridge('siteAttendance',{siteKey:site,month,after,limit:100,snapshot});if(generation!==this.generation||owner!==JSON.stringify(this.identity()))throw Error('ログインが変わりました');return data;}}
root.SharedAttendance={Client:AttendanceClient};if(typeof module!=='undefined')module.exports=root.SharedAttendance;
})(globalThis);
