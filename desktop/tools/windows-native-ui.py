import ctypes as C, ctypes.wintypes as W, json, sys, time
sys.stdout.reconfigure(encoding='utf-8')
u=C.WinDLL('user32',use_last_error=True)
session=W.DWORD()
C.windll.kernel32.ProcessIdToSessionId(C.windll.kernel32.GetCurrentProcessId(),C.byref(session))
if session.value != 1: raise RuntimeError('Run this UI acceptance in Session 1, not SSH Session 0')
u.SetProcessDPIAware()
u.SendMessageW.argtypes=[W.HWND,W.UINT,W.WPARAM,W.LPARAM];u.SendMessageW.restype=C.c_ssize_t
u.GetMenuItemCount.argtypes=[W.HMENU];u.GetMenuItemCount.restype=C.c_int
u.GetMenuStringW.argtypes=[W.HMENU,W.UINT,W.LPWSTR,C.c_int,W.UINT]
u.GetMenuState.argtypes=[W.HMENU,W.UINT,W.UINT];u.GetMenuState.restype=W.UINT
u.GetSubMenu.argtypes=[W.HMENU,C.c_int];u.GetSubMenu.restype=W.HMENU
u.GetMenuItemRect.argtypes=[W.HWND,W.HMENU,W.UINT,C.POINTER(W.RECT)]
def click(x,y,button='left',clicks=1):
 u.SetCursorPos(round(x),round(y));time.sleep(.1)
 down,up=(0x8,0x10) if button=='right' else (0x2,0x4)
 for _ in range(clicks):
  u.mouse_event(down,0,0,0,0);u.mouse_event(up,0,0,0,0);time.sleep(.07)
def entries(menu):
 result=[]
 for i in range(u.GetMenuItemCount(menu)):
  b=C.create_unicode_buffer(1024);u.GetMenuStringW(menu,i,b,1024,0x400)
  state=u.GetMenuState(menu,i,0x400);r=W.RECT();has=u.GetMenuItemRect(None,menu,i,C.byref(r))
  child=u.GetSubMenu(menu,i)
  result.append(dict(label=b.value,enabled=not(state&3),checked=bool(state&8),rect=[r.left,r.top,r.right,r.bottom] if has else None,children=entries(child) if child else []))
 return result
def menus(pid):
 result=[]
 @C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
 def visit(hwnd,param):
  owner=W.DWORD();u.GetWindowThreadProcessId(hwnd,C.byref(owner));b=C.create_unicode_buffer(128);u.GetClassNameW(hwnd,b,128)
  if owner.value==pid and b.value=='#32768':
   menu=u.SendMessageW(hwnd,0x1E1,0,0)
   if menu:result.append(dict(className=b.value,items=entries(menu)))
  return True
 u.EnumWindows(visit,0)
 return result
arg=json.loads(sys.argv[2]);action=sys.argv[1]
if action=='session':print(json.dumps({'sessionId':session.value}))
elif action=='menus':
 for _ in range(50):
  result=menus(arg['pid'])
  if result:break
  time.sleep(.1)
 print(json.dumps(result,ensure_ascii=False))
elif action=='select':
 for _ in range(50):
  found=next((x for m in menus(arg['pid']) for x in m['items'] if x['label'].split('\t')[0]==arg['label'] and x['rect']),None)
  if found:break
  time.sleep(.1)
 if not found:raise RuntimeError('Menu item not found: '+arg['label'])
 if not found['enabled']:raise RuntimeError('Menu item disabled: '+arg['label'])
 l,t,r,b=found['rect'];click((l+r)/2,(t+b)/2);print(json.dumps(found,ensure_ascii=False))
elif action=='click':click(**arg);print('{}')
elif action=='move':u.SetCursorPos(round(arg['x']),round(arg['y']));print('{}')
elif action=='drag':
 x,y=arg['start'];tx,ty=arg['end'];u.SetCursorPos(round(x),round(y));u.mouse_event(2,0,0,0,0);time.sleep(.1)
 for i in range(1,21):
  u.SetCursorPos(round(x+(tx-x)*i/20),round(y+(ty-y)*i/20));time.sleep(.025)
 u.mouse_event(4,0,0,0,0);print('{}')
elif action=='escape':u.keybd_event(27,0,0,0);u.keybd_event(27,0,2,0);print('{}')
elif action=='key-up':u.keybd_event(arg['key'],u.MapVirtualKeyW(arg['key'],0),3,0);print('{}')
elif action=='key-down':u.keybd_event(arg['key'],u.MapVirtualKeyW(arg['key'],0),1,0);print('{}')

elif action=='window':
 hwnd=W.HWND(int(arg['hwnd']));rect=W.RECT();client=W.RECT()
 if not u.GetWindowRect(hwnd,C.byref(rect)) or not u.GetClientRect(hwnd,C.byref(client)):raise RuntimeError('Window geometry unavailable')
 print(json.dumps({'bounds':[rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top],'client':[client.right-client.left,client.bottom-client.top]}))
