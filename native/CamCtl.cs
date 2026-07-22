using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

// Native UVC camera control via DirectShow IAMCameraControl — Pan/Tilt/Zoom/Focus.
// Mirrors what OBS's "Configure Video -> Camera Control" tab does, so the camera
// moves internally (output frame geometry unchanged -> overlay masks stay put).
//
//   CamCtl list                              -> list video capture devices
//   CamCtl get  <match>                      -> JSON of supported controls + ranges
//   CamCtl set  <match> <prop> <raw|auto>    -> set one control (prop: pan|tilt|zoom|focus)
//
// <match> is compared (case-insensitive, substring) against FriendlyName/DevicePath.
class CamCtl
{
    static readonly Guid CLSID_SystemDeviceEnum = new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
    static Guid IID_IBaseFilter = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");
    static Guid IID_IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");

    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICreateDevEnum { [PreserveSig] int CreateClassEnumerator(ref Guid c, out IEnumMoniker e, int f); }

    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyBag { [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string n, out object v, IntPtr e); [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string n, ref object v); }

    [ComImport, Guid("C6E13370-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAMCameraControl {
        [PreserveSig] int GetRange(int p, out int min, out int max, out int step, out int def, out int caps);
        [PreserveSig] int Set(int p, int v, int f);
        [PreserveSig] int Get(int p, out int v, out int f);
    }

    const int Flags_Auto = 1;
    const int Flags_Manual = 2;

    // UI prop name -> IAMCameraControl property index.
    static int PropIndex(string name)
    {
        switch (name.ToLowerInvariant())
        {
            case "pan": return 0;
            case "tilt": return 1;
            case "zoom": return 3;
            case "focus": return 6;
            default: return -1;
        }
    }
    static readonly string[] WANT_NAMES = { "pan", "tilt", "zoom", "focus" };
    static readonly int[] WANT_IDX = { 0, 1, 3, 6 };

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static int Main(string[] argv)
    {
        try
        {
            string cmd = argv.Length > 0 ? argv[0].ToLowerInvariant() : "list";
            if (cmd == "list") { EnumDevices(); return 0; }
            if (argv.Length < 2) { Console.Error.WriteLine("match em falta"); return 2; }
            string match = argv[1];
            IAMCameraControl cc = FindCamera(match);
            if (cc == null) { Console.Error.WriteLine("camara nao encontrada: " + match); return 5; }

            if (cmd == "get") { PrintControls(cc); return 0; }
            if (cmd == "set")
            {
                if (argv.Length < 4) { Console.Error.WriteLine("uso: set <match> <prop> <raw|auto>"); return 2; }
                int p = PropIndex(argv[2]);
                if (p < 0) { Console.Error.WriteLine("prop invalida: " + argv[2]); return 2; }
                int min, max, step, def, caps;
                if (cc.GetRange(p, out min, out max, out step, out def, out caps) != 0)
                { Console.Error.WriteLine(argv[2] + " nao suportado"); return 4; }

                string v = argv[3].ToLowerInvariant();
                int hr, cur, fl;
                if (v == "auto")
                {
                    if ((caps & Flags_Auto) == 0) { Console.Error.WriteLine(argv[2] + " sem auto"); return 4; }
                    hr = cc.Set(p, def, Flags_Auto);
                }
                else
                {
                    int raw;
                    if (!int.TryParse(argv[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out raw))
                    { Console.Error.WriteLine("valor invalido"); return 2; }
                    if (raw < min) raw = min; if (raw > max) raw = max;
                    if (step > 1) raw = min + ((raw - min) / step) * step;
                    hr = cc.Set(p, raw, Flags_Manual);
                }
                cc.Get(p, out cur, out fl);
                Console.WriteLine("{\"ok\":" + (hr == 0 ? "true" : "false") + ",\"prop\":\"" + argv[2].ToLowerInvariant() + "\",\"readback\":" + cur + ",\"flags\":" + fl + ",\"hr\":" + hr + "}");
                return hr == 0 ? 0 : 1;
            }
            Console.Error.WriteLine("comando desconhecido");
            return 2;
        }
        catch (Exception e) { Console.Error.WriteLine("ERRO: " + e.Message); return 1; }
    }

    static void EnumDevices()
    {
        Type t = Type.GetTypeFromCLSID(CLSID_SystemDeviceEnum);
        ICreateDevEnum de = (ICreateDevEnum)Activator.CreateInstance(t);
        IEnumMoniker en; Guid cat = CLSID_VideoInputDeviceCategory;
        de.CreateClassEnumerator(ref cat, out en, 0);
        if (en == null) return;
        IMoniker[] mons = new IMoniker[1];
        while (en.Next(1, mons, IntPtr.Zero) == 0)
        {
            string name = ReadProp(mons[0], "FriendlyName");
            string path = ReadProp(mons[0], "DevicePath");
            Console.WriteLine(name + "\t" + path);
            Marshal.ReleaseComObject(mons[0]);
        }
    }

    static string ReadProp(IMoniker m, string prop)
    {
        try
        {
            object bo; Guid bg = IID_IPropertyBag; m.BindToStorage(null, null, ref bg, out bo);
            object nv; ((IPropertyBag)bo).Read(prop, out nv, IntPtr.Zero);
            return nv as string ?? "";
        }
        catch { return ""; }
    }

    // Match is compared against FriendlyName AND DevicePath (substring, case-insensitive).
    // For identical camera models, pass the unique device-path token (e.g. USB serial)
    // so each physical camera resolves to itself instead of always the first one.
    static IAMCameraControl FindCamera(string match)
    {
        Type t = Type.GetTypeFromCLSID(CLSID_SystemDeviceEnum);
        ICreateDevEnum de = (ICreateDevEnum)Activator.CreateInstance(t);
        IEnumMoniker en; Guid cat = CLSID_VideoInputDeviceCategory;
        de.CreateClassEnumerator(ref cat, out en, 0);
        if (en == null) return null;
        IMoniker[] mons = new IMoniker[1];
        while (en.Next(1, mons, IntPtr.Zero) == 0)
        {
            IMoniker m = mons[0];
            string name = ReadProp(m, "FriendlyName");
            string path = ReadProp(m, "DevicePath");
            bool hit = name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 ||
                       (path.Length > 0 && path.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0);
            if (!hit) { Marshal.ReleaseComObject(m); continue; }
            object fo; Guid bf = IID_IBaseFilter; m.BindToObject(null, null, ref bf, out fo);
            return fo as IAMCameraControl;
        }
        return null;
    }

    static void PrintControls(IAMCameraControl cc)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"controls\":{");
        bool first = true;
        for (int i = 0; i < WANT_IDX.Length; i++)
        {
            int p = WANT_IDX[i];
            int min, max, step, def, caps;
            if (cc.GetRange(p, out min, out max, out step, out def, out caps) != 0) continue;
            int cur, fl; cc.Get(p, out cur, out fl);
            if (!first) sb.Append(",");
            first = false;
            sb.Append("\"" + WANT_NAMES[i] + "\":{");
            sb.Append("\"min\":" + min + ",\"max\":" + max + ",\"step\":" + step + ",\"def\":" + def);
            sb.Append(",\"canAuto\":" + (((caps & Flags_Auto) != 0) ? "true" : "false"));
            sb.Append(",\"current\":" + cur + ",\"auto\":" + ((fl & Flags_Auto) != 0 ? "true" : "false"));
            sb.Append("}");
        }
        sb.Append("}}");
        Console.WriteLine(sb.ToString());
    }
}
