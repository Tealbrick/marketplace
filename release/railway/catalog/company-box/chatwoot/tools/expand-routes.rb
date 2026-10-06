# Expands Chatwoot's config/routes.rb (Rails resources DSL) into flat routes with a mock mapper.
# Usage: ruby expand-routes.rb inputs/routes.rb [enterprise=false] > routes.json
# Handles the DSL this routes.rb uses: namespace, scope module/path, resources, resource, only/except/param/module/controller,
# member/collection blocks, `on:`, nested resources and bare nested verbs, `to: 'controller#action'`, `action:`.
# `ChatwootApp.enterprise?` is false unless the second argument is `true`; `mount`/`require` lines are dropped.
require 'json'

class ChatwootApp
  class << self; attr_accessor :ent; def enterprise?; !!@ent; end; end
end
class Object; def blank?; nil? || (respond_to?(:empty?) && empty?); end; end

def singularize(s)
  s = s.to_s
  return s[0..-4] + 'y' if s.end_with?('ies')
  return s[0..-3] if s =~ /(x|ch|sh|ss)es\z/
  return s[0..-2] if s.end_with?('s') && !s.end_with?('ss')
  s
end
def pluralize(s)
  s = s.to_s
  return s if s.end_with?('s')
  return s[0..-2] + 'ies' if s.end_with?('y')
  return s + 'es' if s =~ /(x|ch|sh)\z/
  s + 's'
end

module ActiveModel; module Type; class Boolean; def cast(v); v.to_s == 'true'; end; end; end; end

class Mapper
  attr_reader :routes
  Frame = Struct.new(:coll, :mem, :nested, :controller)
  CANON = %w[index create new show update destroy]
  def initialize
    @routes = []; @prefix = ''; @modules = []; @stack = []; @level = nil
  end
  def method_missing(name, *args, &blk); nil; end
  def respond_to_missing?(*) = true

  def base = (@stack.last ? @stack.last.nested : @prefix)

  def namespace(name, opts = {}, &blk) = scoped((opts[:path] || name).to_s, name.to_s, &blk)
  def scope(opts = {}, &blk) = scoped(opts[:path]&.to_s, opts[:module]&.to_s, &blk)
  def scoped(path, mod)
    old = [@prefix, @modules.dup, @stack.dup, @level]
    if path
      @prefix = "#{base}/#{path}"
      @stack = []
    end
    @modules << mod if mod
    @level = nil
    yield
  ensure
    @prefix, @modules, @stack, @level = old
  end

  def resources(name, opts = {}, &blk) = define(name, opts, false, &blk)
  def resource(name, opts = {}, &blk) = define(name, opts, true, &blk)

  def define(name, opts, singular, &blk)
    name = name.to_s
    seg = (opts[:path] || name).to_s
    mods = @modules + (opts[:module] ? [opts[:module].to_s] : [])
    controller = (opts[:controller] || (singular ? pluralize(name) : name)).to_s
    all = singular ? %i[show create update destroy] : %i[index create show update destroy]
    acts = all
    acts = Array(opts[:only]).map(&:to_sym) & all if opts.key?(:only)
    acts -= Array(opts[:except]).map(&:to_sym) if opts.key?(:except)
    param = (opts[:param] || :id).to_s
    coll = "#{base}/#{seg}"
    mem = singular ? coll : "#{coll}/:#{param}"
    nested = singular ? coll : "#{coll}/:#{singularize(name)}_#{opts[:param] ? param : 'id'}"
    acts.each do |a|
      case a
      when :index then add('GET', coll, mods, controller, 'index')
      when :create then add('POST', coll, mods, controller, 'create')
      when :show then add('GET', mem, mods, controller, 'show')
      when :update then add('PATCH', mem, mods, controller, 'update')
      when :destroy then add('DELETE', mem, mods, controller, 'destroy')
      end
    end
    return unless blk
    old = [@stack.dup, @modules.dup, @level]
    begin
      @stack << Frame.new(coll, mem, nested, controller)
      @modules = mods
      @level = nil
      instance_eval(&blk)
    ensure
      @stack, @modules, @level = old
    end
  end

  def collection(&blk) = at_level(:collection, &blk)
  def member(&blk) = at_level(:member, &blk)
  def at_level(l)
    old = @level; @level = l; yield
  ensure
    @level = old
  end

  %w[get post put patch delete].each do |verb|
    define_method(verb) do |*args, **opts, &blk|
      verb_route(verb.upcase, args.first, opts)
    end
  end

  def verb_route(verb, path, opts)
    frame = @stack.last
    ctrl = nil; act = path.to_s
    if opts[:to].is_a?(String) && opts[:to].include?('#')
      ctrl, act = opts[:to].split('#', 2)
    end
    act = opts[:action].to_s if opts[:action]
    on = opts[:on] || @level
    name = path.to_s
    if frame
      ctrl ||= frame.controller
      full = case on
             when :member then CANON.include?(name) ? frame.mem : "#{frame.mem}/#{name}"
             when :collection then CANON.include?(name) ? frame.coll : "#{frame.coll}/#{name}"
             else "#{frame.nested}/#{name}"
             end
    else
      full = "#{@prefix}/#{name}"
    end
    add(verb, full, @modules, ctrl, act)
  end

  def add(verb, path, mods, controller, action)
    @routes << { verb: verb, path: path.gsub('//', '/'), modules: mods.dup, controller: controller, action: action }
  end
end

src = File.read(ARGV[0])
ChatwootApp.ent = ARGV[1] == 'true'
m = Mapper.new
class Mapper; end
module Rails; def self.env; Struct.new(:production?).new(true); end; end
# Evaluate the file body inside the mapper.
body = src.sub(/\ARails\.application\.routes\.draw do\n/, '').sub(/\nend\s*\z/, "\n")
body = body.gsub(/^\s*require .*$/, '').gsub(/^\s*mount .*$/, '')
m.instance_eval(body)
puts JSON.pretty_generate(m.routes)
