"""仅空间区域切割：三角边插值位置/UV，保留外部轮廓；不按UV seam连通块猜部件。"""
import numpy as np

def halfspace(polygon,axis,value,sign):
 """polygon rows=[x,y,z,u,v]；保留 sign*(position[axis]-value)>=0。"""
 inside=[];outside=[]
 if not len(polygon):return inside,outside
 for a,b in zip(polygon,np.roll(polygon,-1,axis=0)):
  da=sign*(a[axis]-value);db=sign*(b[axis]-value)
  (inside if da>=0 else outside).append(a)
  if (da<0)!=(db<0):
   point=a+(b-a)*(da/(da-db));point[axis]=value
   inside.append(point);outside.append(point.copy())
 return inside,outside

def partition(vertices,faces,uv,planes):
 """交集为待移出区域；补集按首次离开平面收集，避免重复外部三角。"""
 groups=[[],[]]
 for face in faces:
  polygon=np.column_stack([vertices[face],uv[face]])
  for axis,value,sign in planes:
   keep,out=halfspace(np.asarray(polygon),axis,value,sign)
   if len(out)>=3:groups[0].append(np.asarray(out))
   polygon=keep
   if len(polygon)<3:break
  if len(polygon)>=3:groups[1].append(np.asarray(polygon))
 def triangulate(polygons):
  corners=[]
  for poly in polygons:
   for j in range(1,len(poly)-1):
    triangle=poly[[0,j,j+1]]
    if np.linalg.norm(np.cross(triangle[1,:3]-triangle[0,:3],triangle[2,:3]-triangle[0,:3]))>1e-12:corners.extend(triangle)
  corners=np.asarray(corners);return corners[:,:3],np.arange(len(corners)).reshape(-1,3),corners[:,3:]
 return tuple(triangulate(g) for g in groups)

def cap_boundary(vertices,faces,max_edges=200):
 """仅补剩余简单定向边界环；有分叉/超界则拒绝。用于native忽略的三边局部孔。"""
 edges={}
 for face in faces:
  for a,b in zip(face,np.roll(face,-1)):
   key=tuple(sorted((int(a),int(b))));edges.setdefault(key,[]).append((int(a),int(b)))
 boundary=[e[0] for e in edges.values() if len(e)==1];out={};incoming={}
 for a,b in boundary:
  if a in out or b in incoming:raise ValueError('边界分叉，不能安全封口')
  out[a]=b;incoming[b]=a
 vertices=list(vertices);faces=list(faces);added=0
 while out:
  start=next(iter(out));loop=[start];current=start
  while True:
   if current not in out:raise ValueError('边界不是闭环')
   current=out.pop(current)
   if current==start:break
   loop.append(current)
   if len(loop)>max_edges:raise ValueError('边界超过局部封口范围')
  if len(loop)<3:raise ValueError('退化边界环')
  if len(loop)==3:faces.append([loop[0],loop[2],loop[1]]);added+=1
  else:
   center=len(vertices);vertices.append(np.mean(np.asarray(vertices)[loop],axis=0))
   for a,b in zip(loop,np.roll(loop,-1)):faces.append([b,a,center]);added+=1
 return np.asarray(vertices),np.asarray(faces),added
