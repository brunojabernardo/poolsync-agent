using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

// Minimal DirectShow camera-focus helper.
//   CamFocus list                       -> list video capture devices
//   CamFocus get   <match>              -> print focus range + current value
//   CamFocus set   <match> auto         -> enable autofocus
//   CamFocus set   <match> <0..100>     -> manual focus, percent mapped to device range
// <match> is compared (case-insensitive, substring) against FriendlyName and DevicePath.
class CamFocus
{
    static readonly Guid CLSID_SystemDeviceEnum = new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
    static Guid IID_IBaseFilter = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");
    static Guid IID_IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");

    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICreateDevEnum
    {
        [PreserveSig] int CreateClassEnumerator(ref Guid clsidDeviceClass, out IEnumMoniker ppEnumMoniker, int dwFlags);
    }

    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyBag
    {
        [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string name, out object val, IntPtr errorLog);
        [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string name, ref object val);
    }

    [ComImport, Guid("C6E13370-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAMCameraControl
    {
        [PreserveSig] int GetRange(int Property, out int pMin, out int pMax, out int pSteppingDelta, out int pDefault, out int pCapsFlags);
        [PreserveSig] int Set(int Property, int lValue, int Flags);
        [PreserveSig] int Get(int Property, out int lValue, out int Flags);
    }

    const int CameraControl_Focus = 6;
    const int Flags_Auto = 1;
    const int Flags_Manual = 2;

    static int Main(string[] argv)
    {
        try
        {
            string cmd = argv.Length > 0 ? argv[0].ToLowerInvariant() : "list";
            if (cmd == "list") { Enumerate(null, null, 0); return 0; }
            if (argv.Length < 2) { Console.Error.WriteLine("match em falta"); return 2; }
            string match = argv[1];
            if (cmd == "get") return Enumerate(match, "get", 0);
            if (cmd == "set")
            {
                if (argv.Length < 3) { Console.Error.WriteLine("valor em falta"); return 2; }
                string v = argv[2].ToLowerInvariant();
                if (v == "auto") return Enumerate(match, "auto", 0);
                int pct;
                if (!int.TryParse(argv[2], out pct)) { Console.Error.WriteLine("valor invalido"); return 2; }
                return Enumerate(match, "set", pct);
            }
            Console.Error.WriteLine("comando desconhecido");
            return 2;
        }
        catch (Exception e) { Console.Error.WriteLine("ERRO: " + e.Message); return 1; }
    }

    static int Enumerate(string match, string action, int pct)
    {
        Type t = Type.GetTypeFromCLSID(CLSID_SystemDeviceEnum);
        ICreateDevEnum devEnum = (ICreateDevEnum)Activator.CreateInstance(t);
        IEnumMoniker en;
        Guid cat = CLSID_VideoInputDeviceCategory;
        devEnum.CreateClassEnumerator(ref cat, out en, 0);
        if (en == null) { Console.Error.WriteLine("sem dispositivos de video"); return 1; }

        IMoniker[] mons = new IMoniker[1];
        bool found = false;
        while (en.Next(1, mons, IntPtr.Zero) == 0)
        {
            IMoniker m = mons[0];
            string name = "?", path = "";
            try
            {
                object bagObj;
                Guid bagId = IID_IPropertyBag;
                m.BindToStorage(null, null, ref bagId, out bagObj);
                IPropertyBag bag = (IPropertyBag)bagObj;
                object nv; bag.Read("FriendlyName", out nv, IntPtr.Zero); name = nv as string ?? "?";
                object pv = null; try { bag.Read("DevicePath", out pv, IntPtr.Zero); } catch { }
                path = pv as string ?? "";
            }
            catch { }

            if (action == null) { Console.WriteLine(name + " | " + path); Marshal.ReleaseComObject(m); continue; }

            bool hit = match != null && (
                name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 ||
                (path.Length > 0 && path.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0));
            if (!hit) { Marshal.ReleaseComObject(m); continue; }

            found = true;
            object filterObj;
            Guid bf = IID_IBaseFilter;
            m.BindToObject(null, null, ref bf, out filterObj);
            IAMCameraControl cc = filterObj as IAMCameraControl;
            if (cc == null) { Console.Error.WriteLine("camara sem IAMCameraControl: " + name); return 3; }

            int min, max, step, def, caps;
            int hr = cc.GetRange(CameraControl_Focus, out min, out max, out step, out def, out caps);
            if (hr != 0) { Console.Error.WriteLine("Focus nao suportado (hr=" + hr + ") em " + name); return 4; }

            if (action == "get")
            {
                int cur, fl; cc.Get(CameraControl_Focus, out cur, out fl);
                Console.WriteLine("device=" + name);
                Console.WriteLine("min=" + min + " max=" + max + " step=" + step + " default=" + def + " caps=" + caps);
                Console.WriteLine("current=" + cur + " flags=" + fl);
            }
            else if (action == "auto")
            {
                int hr2 = cc.Set(CameraControl_Focus, def, Flags_Auto);
                Console.WriteLine("auto set hr=" + hr2);
            }
            else if (action == "set")
            {
                if (pct < 0) pct = 0; if (pct > 100) pct = 100;
                int val = min + (int)Math.Round((pct / 100.0) * (max - min));
                if (step > 1) val = min + ((val - min) / step) * step;
                if (val < min) val = min; if (val > max) val = max;
                int hr2 = cc.Set(CameraControl_Focus, val, Flags_Manual);
                int cur, fl; cc.Get(CameraControl_Focus, out cur, out fl);
                Console.WriteLine("set pct=" + pct + " -> raw=" + val + " hr=" + hr2 + " readback=" + cur + " flags=" + fl);
            }
            Marshal.ReleaseComObject(m);
            break;
        }
        if (action != null && !found) { Console.Error.WriteLine("camara nao encontrada: " + match); return 5; }
        return 0;
    }
}
